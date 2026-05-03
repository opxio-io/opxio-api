// handlers/clients/shin-supplies/crm-pipeline.js
// CRM & Pipeline dashboard
//
// Cache strategy (fastest → slowest):
//   1. In-memory cache — HIT: return instantly, no I/O
//   2. In-flight dedup — concurrent cold-cache requests share one Notion call
//   3. Notion API — queued (max 3 concurrent), 8s timeout, circuit breaker
//
// X-Cache header: HIT | STALE | MISS

import { getClientByToken, getNotionToken, resolveDB } from "../../../lib/supabase.js"
import { cacheGet, cacheSet, cacheKey }                from "../../../lib/cache.js"
import { notionQueue }                                  from "../../../lib/queue.js"
import { createClient }                                 from "@supabase/supabase-js"

const ENQUIRY_DB_DEFAULT = '71c9ba4af0694291876bf78422805f18'
const PEOPLE_DB_DEFAULT  = '34cfe60097f680e1bac0e75b431bc325'
const EXCLUDED           = ['Unassigned', 'Nurhan']
const STAGE_ORDER        = ['New Lead', 'Quotation Sent', 'Negotiation', 'Sales Order Issued', 'Closed Won', 'Closed Lost']
const NOTION_TIMEOUT_MS  = 8_000

// ── In-flight deduplication ───────────────────────────────────────────────
const _inflight = new Map()

// ── Supabase client for async logging ────────────────────────────────────
let _sb = null
function getSb() {
  if (!_sb && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    _sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false }
    })
  }
  return _sb
}

// ── Async usage logger (fire-and-forget, never blocks response) ───────────
function logUsage({ clientId, cacheStatus, latencyMs, httpStatus = 200, error = null }) {
  const sb = getSb()
  if (!sb) return
  sb.from('api_usage').insert({
    client_id:     clientId,
    endpoint:      'shin-supplies/crm-pipeline',
    cache_status:  cacheStatus,
    latency_ms:    Math.round(latencyMs),
    http_status:   httpStatus,
    error_message: error,
    timestamp:     new Date().toISOString(),
  }).then(({ error: e }) => {
    if (e) console.error('[log] api_usage insert failed:', e.message)
  })
}

// ── Notion paginator — queued + timeout + optional date filter ────────────
async function queryAll(dbId, notionKey, filter = null) {
  const headers = {
    Authorization:    `Bearer ${notionKey}`,
    'Notion-Version': '2022-06-28',
    'Content-Type':   'application/json',
  }
  let results = [], hasMore = true, cursor
  while (hasMore) {
    const ctrl  = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), NOTION_TIMEOUT_MS)
    try {
      const body = { page_size: 100 }
      if (cursor) body.start_cursor = cursor
      if (filter)  body.filter      = filter
      // Each page fetch goes through the shared Notion queue (max 3 concurrent)
      const d = await notionQueue.add(async () => {
        const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
          method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal,
        })
        if (!r.ok) throw new Error(`Notion ${r.status}: ${await r.text()}`)
        return r.json()
      })
      results = results.concat(d.results)
      hasMore  = d.has_more
      cursor   = d.next_cursor
    } finally {
      clearTimeout(timer)
    }
  }
  return results
}

// 13-month cutoff — enough for current month + 12 months back navigation
function leadsDateFilter() {
  const d = new Date()
  d.setMonth(d.getMonth() - 13)
  d.setDate(1)
  return {
    property: 'Submitted At',
    date: { on_or_after: d.toISOString().slice(0, 10) },
  }
}

// ── Property getters ──────────────────────────────────────────────────────
const getTitle    = p => (p?.title        || []).map(t => t.plain_text).join('')
const getStatus   = p => p?.status?.name  || p?.select?.name || null
const getDate     = p => p?.date?.start   || null
const getCheckbox = p => p?.checkbox === true
const getRelIds   = p => (p?.relation     || []).map(r => r.id)
const getMultiSel = p => (p?.multi_select || []).map(s => s.name)

// ── Stats computation (pure) ──────────────────────────────────────────────
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

// ── Shared fetch logic (used by MISS and background STALE refresh) ────────
function buildFetchPromise(ck, notionKey, enquiryDb, peopleDb) {
  if (_inflight.has(ck)) return _inflight.get(ck)
  const p = Promise.all([
    queryAll(enquiryDb, notionKey, leadsDateFilter()),
    queryAll(peopleDb,  notionKey).catch(() => []),
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
  return p
}

// ── Request handler ───────────────────────────────────────────────────────
export async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const t0    = Date.now()
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

  const ck         = cacheKey('shin-supplies:crm-pipeline', client.id)
  const hit        = cacheGet(ck)
  const notionKey  = getNotionToken(client)
  const enquiryDb  = resolveDB(client, 'enquiry_submissions', ENQUIRY_DB_DEFAULT)
  const peopleDb   = resolveDB(client, 'people', PEOPLE_DB_DEFAULT)

  function respond(data, cacheStatus) {
    res.setHeader('X-Cache', cacheStatus)
    const stats = computeStats({ ...data, mStart, mEnd, now })
    res.status(200).json({ total: data.total, ...stats, updatedAt: now.toISOString(), filterMonth: { year: mYear, month: mMon } })
    logUsage({ clientId: client.id, cacheStatus, latencyMs: Date.now() - t0 })
  }

  // ── HIT ────────────────────────────────────────────────────────────────
  if (hit && !hit.stale) return respond(hit.data, 'HIT')

  // ── STALE: respond immediately, refresh in background ─────────────────
  if (hit && hit.stale) {
    respond(hit.data, 'STALE')
    buildFetchPromise(ck, notionKey, enquiryDb, peopleDb)
      .catch(e => console.error('[crm-pipeline] bg refresh failed:', e.message))
    return
  }

  // ── MISS: fetch, deduplicated ──────────────────────────────────────────
  try {
    const data = await buildFetchPromise(ck, notionKey, enquiryDb, peopleDb)
    respond(data, 'MISS')
  } catch (e) {
    console.error('[crm-pipeline] fetch error:', e.message)
    // Circuit breaker: check for any stale entry one more time
    const stale = cacheGet(ck)
    if (stale) return respond(stale.data, 'STALE')
    logUsage({ clientId: client.id, cacheStatus: 'MISS', latencyMs: Date.now() - t0, httpStatus: 503, error: e.message })
    res.status(503).json({ error: 'Notion API unavailable and no cache exists. Try again shortly.' })
  }
}
