// handlers/clients/shin-supplies/crm-pipeline.js
// CRM & Pipeline dashboard
//
// Cache strategy (fastest → slowest):
//   1. In-memory cache — HIT: return instantly, no I/O
//   2. In-flight dedup — if a Notion fetch is already running, wait for it (no duplicate calls)
//   3. Notion API — with 8s timeout + circuit breaker (serve STALE on timeout, error if no cache)
//
// X-Cache header: HIT | STALE | MISS

import { getClientByToken, getNotionToken, resolveDB } from "../../../lib/supabase.js"
import { cacheGet, cacheSet, cacheKey } from "../../../lib/cache.js"

const ENQUIRY_DB_DEFAULT = '71c9ba4af0694291876bf78422805f18'
const PEOPLE_DB_DEFAULT  = '34cfe60097f680e1bac0e75b431bc325'
const EXCLUDED           = ['Unassigned', 'Nurhan']
const STAGE_ORDER        = ['New Lead', 'Quotation Sent', 'Negotiation', 'Sales Order Issued', 'Closed Won', 'Closed Lost']
const NOTION_TIMEOUT_MS  = 8_000  // give up on Notion after 8s, serve stale

// ── In-flight deduplication ───────────────────────────────────────────────
// If two requests arrive simultaneously on a cold cache, only ONE Notion call
// is made. The second request waits for the same promise.
const _inflight = new Map()

// ── Notion query with timeout ─────────────────────────────────────────────
async function queryAll(dbId, notionKey) {
  const headers = {
    Authorization:    `Bearer ${notionKey}`,
    'Notion-Version': '2022-06-28',
    'Content-Type':   'application/json',
  }
  let results = [], hasMore = true, cursor
  while (hasMore) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), NOTION_TIMEOUT_MS)
    try {
      const body = { page_size: 100 }
      if (cursor) body.start_cursor = cursor
      const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
        method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal,
      })
      if (!r.ok) throw new Error(`Notion ${r.status}: ${await r.text()}`)
      const d = await r.json()
      results = results.concat(d.results)
      hasMore  = d.has_more
      cursor   = d.next_cursor
    } finally {
      clearTimeout(timer)
    }
  }
  return results
}

// ── Property getters ──────────────────────────────────────────────────────
const getTitle    = p => (p?.title        || []).map(t => t.plain_text).join('')
const getStatus   = p => p?.status?.name  || p?.select?.name || null
const getDate     = p => p?.date?.start   || null
const getCheckbox = p => p?.checkbox === true
const getRelIds   = p => (p?.relation     || []).map(r => r.id)
const getMultiSel = p => (p?.multi_select || []).map(s => s.name)

// ── Stats computation (pure — no I/O) ────────────────────────────────────
function computeStats({ pages, repMap, mStart, mEnd, now }) {
  const today = now.toISOString().slice(0, 10)
  const d3    = new Date(now); d3.setDate(now.getDate() + 3)
  const d3Str = d3.toISOString().slice(0, 10)

  let monthLeads = 0, quotationsSent = 0, closedWon = 0, closedLost = 0
  let followupsToday = 0, followupsNext3 = 0, overdueResponse = 0

  const stageCount = {}, productCount = {}, sourceCount = {}, sourceClosedCount = {}, repStats = {}

  for (const page of pages) {
    const p         = page.properties
    const status    = getStatus(p['Status'])
    const submAt    = getDate(p['Submitted At'])
    const quoIssued = getCheckbox(p['Quotation Issued'])
    const nextFU    = getDate(p['Next Follow-up Date'])
    const assigned  = getRelIds(p['Assigned To'])
    const products  = getMultiSel(p['Kategori produk'])
    const source    = getStatus(p['Lead Source'])

    if (!status) continue

    const submDate = submAt ? new Date(submAt) : null
    const ageH     = submDate ? (now - submDate) / 3600000 : null
    const inMonth  = submDate && submDate >= mStart && submDate < mEnd
    const isClosed = status === 'Closed Won' || status === 'Closed Lost' || status === 'Done'
    const isWon    = status === 'Closed Won'  || status === 'Done'
    const isLost   = status === 'Closed Lost'

    let repName = 'Unassigned'
    if (assigned.length > 0) {
      const rid = assigned[0]
      repName = repMap[rid] || repMap[rid.replace(/-/g, '')] || 'Unassigned'
    }
    if (!repStats[repName]) repStats[repName] = { closedWon: 0, closedLost: 0, activePipeline: 0, activities: 0, followupsToday: 0 }

    if (inMonth) {
      monthLeads++
      repStats[repName].activities++
      const stageKey = status === 'Done' ? 'Closed Won' : status
      stageCount[stageKey] = (stageCount[stageKey] || 0) + 1
      for (const prod of products) productCount[prod] = (productCount[prod] || 0) + 1
      if (source) {
        sourceCount[source] = (sourceCount[source] || 0) + 1
        if (isWon) sourceClosedCount[source] = (sourceClosedCount[source] || 0) + 1
      }
      if (status !== 'New Lead') {
        quotationsSent++
        if (isWon)  { closedWon++;  repStats[repName].closedWon++ }
        if (isLost) { closedLost++; repStats[repName].closedLost = (repStats[repName].closedLost || 0) + 1 }
      }
    }

    if (nextFU && !isClosed) {
      if (nextFU <= today) { followupsToday++; repStats[repName].followupsToday++ }
      if (nextFU <= d3Str) followupsNext3++
    }
    if (!isClosed && !quoIssued && status === 'New Lead' && ageH !== null && ageH > 2) overdueResponse++
    if (!isClosed) repStats[repName].activePipeline++
  }

  const totalDecided = closedWon + closedLost
  const closeRate    = totalDecided > 0 ? Math.round((closedWon / totalDecided) * 100) : null
  const stageFunnel  = STAGE_ORDER.map(s => ({ stage: s, count: stageCount[s] || 0 }))
  const repBreakdown = Object.entries(repStats)
    .filter(([name]) => !EXCLUDED.includes(name))
    .map(([name, s]) => ({ name, closedWon: s.closedWon || 0, closedLost: s.closedLost || 0, activePipeline: s.activePipeline || 0, activities: s.activities || 0, followupsToday: s.followupsToday || 0 }))
    .sort((a, b) => b.closedWon - a.closedWon || b.activePipeline - a.activePipeline)

  return {
    monthLeads, quotationsSent, closedWon, closedLost, closeRate,
    live: { followupsToday, followupsNext3, overdueResponse },
    stageFunnel, repBreakdown,
    productBreakdown: productCount,
    sourceBreakdown: Object.fromEntries(
      Object.entries(sourceCount).map(([src, count]) => [src, { leads: count, closed: sourceClosedCount[src] || 0 }])
    ),
  }
}

// ── Request handler ───────────────────────────────────────────────────────
export async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const token = req.query.token || req.headers['x-widget-token']
  if (!token) return res.status(401).json({ error: 'Missing token' })
  const client = await getClientByToken(token)
  if (!client) return res.status(403).json({ error: 'Invalid token' })

  const now    = new Date()
  const qMonth = req.query.month !== undefined ? parseInt(req.query.month) : null
  const qYear  = req.query.year  !== undefined ? parseInt(req.query.year)  : null
  const mYear  = (qMonth !== null && qYear !== null && !isNaN(qMonth) && !isNaN(qYear)) ? qYear  : now.getFullYear()
  const mMon   = (qMonth !== null && qYear !== null && !isNaN(qMonth) && !isNaN(qYear)) ? qMonth : now.getMonth()
  const mStart = new Date(mYear, mMon, 1)
  const mEnd   = new Date(mYear, mMon + 1, 1)

  const ck  = cacheKey('shin-supplies:crm-pipeline', client.id)
  const hit = cacheGet(ck)

  // ── HIT: fresh cache — return instantly ──────────────────────────────
  if (hit && !hit.stale) {
    res.setHeader('X-Cache', 'HIT')
    const stats = computeStats({ ...hit.data, mStart, mEnd, now })
    return res.status(200).json({ total: hit.data.total, ...stats, updatedAt: now.toISOString(), filterMonth: { year: mYear, month: mMon } })
  }

  // ── STALE: serve immediately, refresh in background ──────────────────
  if (hit && hit.stale) {
    res.setHeader('X-Cache', 'STALE')
    const stats = computeStats({ ...hit.data, mStart, mEnd, now })
    res.status(200).json({ total: hit.data.total, ...stats, updatedAt: now.toISOString(), filterMonth: { year: mYear, month: mMon } })
    // Background refresh — deduplicated
    if (!_inflight.has(ck)) {
      const notionKey  = getNotionToken(client)
      const enquiryDb  = resolveDB(client, 'enquiry_submissions', ENQUIRY_DB_DEFAULT)
      const peopleDb   = resolveDB(client, 'people', PEOPLE_DB_DEFAULT)
      const p = Promise.all([
        queryAll(enquiryDb, notionKey),
        queryAll(peopleDb, notionKey).catch(() => []),
      ]).then(([pages, people]) => {
        const repMap = {}
        for (const p of people) {
          const nameProp = p.properties['Name'] || p.properties['Nama'] || p.properties['Full Name']
          const name = getTitle(nameProp)
          if (name) { repMap[p.id] = name; repMap[p.id.replace(/-/g, '')] = name }
        }
        cacheSet(ck, { pages, repMap, total: pages.length })
      }).catch(e => {
        console.error('[crm-pipeline] bg refresh failed:', e.message)
      }).finally(() => _inflight.delete(ck))
      _inflight.set(ck, p)
    }
    return
  }

  // ── MISS: must fetch — deduplicated in-flight ─────────────────────────
  try {
    if (!_inflight.has(ck)) {
      const notionKey = getNotionToken(client)
      const enquiryDb = resolveDB(client, 'enquiry_submissions', ENQUIRY_DB_DEFAULT)
      const peopleDb  = resolveDB(client, 'people', PEOPLE_DB_DEFAULT)
      const p = Promise.all([
        queryAll(enquiryDb, notionKey),
        queryAll(peopleDb, notionKey).catch(() => []),
      ]).then(([pages, people]) => {
        const repMap = {}
        for (const person of people) {
          const nameProp = person.properties['Name'] || person.properties['Nama'] || person.properties['Full Name']
          const name = getTitle(nameProp)
          if (name) { repMap[person.id] = name; repMap[person.id.replace(/-/g, '')] = name }
        }
        const fresh = { pages, repMap, total: pages.length }
        cacheSet(ck, fresh)
        return fresh
      }).finally(() => _inflight.delete(ck))
      _inflight.set(ck, p)
    }

    const cached = await _inflight.get(ck)
    res.setHeader('X-Cache', 'MISS')
    const stats = computeStats({ ...cached, mStart, mEnd, now })
    return res.status(200).json({ total: cached.total, ...stats, updatedAt: now.toISOString(), filterMonth: { year: mYear, month: mMon } })

  } catch (e) {
    console.error('[crm-pipeline] fetch error:', e.message)
    // Circuit breaker: if stale exists, serve it rather than erroring
    const stale = cacheGet(ck)
    if (stale) {
      res.setHeader('X-Cache', 'STALE')
      const stats = computeStats({ ...stale.data, mStart, mEnd, now })
      return res.status(200).json({ total: stale.data.total, ...stats, updatedAt: now.toISOString(), filterMonth: { year: mYear, month: mMon } })
    }
    return res.status(503).json({ error: 'Data unavailable — Notion API timed out and no cache available. Try again shortly.' })
  }
}
