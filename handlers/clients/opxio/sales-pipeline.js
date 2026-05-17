// handlers/clients/opxio/sales-pipeline.js
// Opxio internal — Sales Pipeline widget

import { getClientByToken, getNotionToken } from "../../../lib/supabase.js"
import { cacheGet, cacheSet, cacheKey } from "../../../lib/cache.js"

const LEADS_DB = '340fe60097f6810091cfe204a1c13f5f'
const DEALS_DB  = 'caafe60097f683398df40197eeedbffe'

const LEAD_FUNNEL_ORDER = ['New Lead','Contacted','Discovery Booked','Discovery Done','Qualified','Needs Review','Converted']
const LEAD_OPEN         = new Set(['New Lead','Contacted','Discovery Booked','Discovery Done','Qualified','Needs Review'])
const DEAL_STAGE_ORDER  = ['Discovery Done','Proposal Sent','Quotation Sent','Negotiation','Closed-Won']
const DEAL_OPEN         = new Set(['Discovery Done','Proposal Sent','Quotation Sent','Negotiation'])

async function queryAll(dbId, notionKey) {
  const headers = {
    'Authorization': `Bearer ${notionKey}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  }
  let results = [], hasMore = true, cursor
  while (hasMore) {
    const body = { page_size: 100 }
    if (cursor) body.start_cursor = cursor
    const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: 'POST', headers, body: JSON.stringify(body)
    })
    if (!r.ok) throw new Error(await r.text())
    const d = await r.json()
    results = results.concat(d.results)
    hasMore = d.has_more
    cursor  = d.next_cursor
  }
  return results
}

const getTitle  = p => (p?.title      || []).map(t => t.plain_text).join('').trim()
const getStatus = p => p?.status?.name || p?.select?.name || null
const getDate   = p => p?.date?.start  || null
const getNumber = p => p?.number ?? null
const getMulti  = p => (p?.multi_select || []).map(s => s.name)

export async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const token = req.query.token || req.headers['x-widget-token']
  if (!token) return res.status(401).json({ error: 'Missing token' })
  const client = await getClientByToken(token)
  if (!client) return res.status(403).json({ error: 'Invalid token' })

  const NOTION_KEY = getNotionToken(client)
  const ck = cacheKey('opxio:sales-pipeline', client.id)
  let cached = cacheGet(ck)

  if (!cached) {
    const [leads, deals] = await Promise.all([
      queryAll(LEADS_DB, NOTION_KEY),
      queryAll(DEALS_DB,  NOTION_KEY),
    ])
    cacheSet(ck, { leads, deals })
    cached = { data: { leads, deals }, stale: false }
  } else if (cached.stale) {
    Promise.all([
      queryAll(LEADS_DB, NOTION_KEY),
      queryAll(DEALS_DB,  NOTION_KEY),
    ]).then(([leads, deals]) => cacheSet(ck, { leads, deals })).catch(console.error)
  }

  const { leads, deals } = cached.data

  const now    = new Date()
  const today  = now.toISOString().slice(0, 10)
  const staleThreshold = new Date(now - 7 * 24 * 60 * 60 * 1000)

  // Month filter
  const qMonth = req.query.month !== undefined ? parseInt(req.query.month) : null
  const qYear  = req.query.year  !== undefined ? parseInt(req.query.year)  : null
  const fStart = (qMonth !== null && qYear !== null) ? new Date(qYear, qMonth, 1)     : new Date(now.getFullYear(), now.getMonth(), 1)
  const fEnd   = (qMonth !== null && qYear !== null) ? new Date(qYear, qMonth + 1, 0) : new Date(now.getFullYear(), now.getMonth() + 1, 0)

  // ── Lead metrics ──────────────────────────────────────────────────────────
  let openLeads = 0, newLeadsMTD = 0, convertedTotal = 0
  const leadsByStage = {}
  const sourceMap    = {}   // { name: { leads, closed } }
  const hotLeads     = []
  const followupDue  = []

  for (const page of leads) {
    const p       = page.properties
    const stage   = getStatus(p['Stage'])
    const qual    = getStatus(p['Qualification Score'])
    const name    = getTitle(p['Lead Name']) || '(Unnamed)'
    const created = new Date(page.created_time)
    const lastFU  = getDate(p['Last Follow-Up'])
    const sources = getMulti(p['Source'])

    if (!stage) continue

    // Stage funnel counts
    leadsByStage[stage] = (leadsByStage[stage] || 0) + 1

    // Source breakdown — all leads
    for (const src of sources) {
      if (!sourceMap[src]) sourceMap[src] = { leads: 0, closed: 0 }
      sourceMap[src].leads++
      if (stage === 'Converted') sourceMap[src].closed++
    }

    // Open leads
    if (LEAD_OPEN.has(stage)) {
      openLeads++
      if (qual === 'Hot' && name && name !== 'undefined' && name.trim().length > 2) hotLeads.push(name)
      if (lastFU && lastFU <= today && name && name !== 'undefined' && name.trim().length > 2) followupDue.push({ name, lastFU })
    }

    // New leads this period
    if (created >= fStart && created <= fEnd) newLeadsMTD++
    if (stage === 'Converted') convertedTotal++
  }

  // ── Deal metrics ──────────────────────────────────────────────────────────
  let openDeals = 0, pipelineValue = 0, closedWonMTD = 0
  const dealsByStage = {}
  const stalledDeals = []

  for (const page of deals) {
    const p         = page.properties
    const stage     = getStatus(p['Stage'])
    const name      = getTitle(p['Deal Name']) || '(Unnamed)'
    const estValue  = getNumber(p['Estimated Value'])
    const closeDate = getDate(p['Actual Close Date'])
    const lastEdit  = new Date(page.last_edited_time)
    const osComb    = getMulti(p['OS Combination'])

    if (!stage) continue
    dealsByStage[stage] = (dealsByStage[stage] || 0) + 1

    if (DEAL_OPEN.has(stage)) {
      openDeals++
      if (estValue) pipelineValue += estValue
      if (lastEdit < staleThreshold) {
        const daysStale = Math.floor((now - lastEdit) / 86400000)
        if (name && name !== 'undefined' && name.trim().length > 2) stalledDeals.push({ name, stage, daysStale, os: osComb.join(' + ') || '—' })
      }
    }

    if (stage === 'Closed-Won') {
      const ref = closeDate ? new Date(closeDate) : new Date(page.created_time)
      if (ref >= fStart && ref <= fEnd) closedWonMTD++
    }
  }

  // ── Monthly trend (last 12 months) ───────────────────────────────────────
  const monthlyTrend = []
  for (let i = 11; i >= 0; i--) {
    const d  = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const mS = new Date(d.getFullYear(), d.getMonth(), 1)
    const mE = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59)
    const count = leads.filter(p => {
      const c = new Date(p.created_time)
      return c >= mS && c <= mE
    }).length
    monthlyTrend.push({
      label: d.toLocaleString('default', { month: 'short' }),
      count,
    })
  }

  const convRate = leads.length > 0 ? Math.round((convertedTotal / leads.length) * 100) : 0
  stalledDeals.sort((a, b) => b.daysStale - a.daysStale)

  const leadFunnel = LEAD_FUNNEL_ORDER.map(s => ({ stage: s, count: leadsByStage[s] || 0 }))
  const dealFunnel = DEAL_STAGE_ORDER.map(s  => ({ stage: s, count: dealsByStage[s]  || 0 }))

  // Dropped this period
  const droppedUnqualified = leadsByStage['Unqualified'] || 0

  return res.status(200).json({
    kpi: {
      newLeadsMTD,
      openLeads,
      openDeals,
      pipelineValue: Math.round(pipelineValue),
      closedWonMTD,
      convRate,
    },
    leadFunnel,
    dealFunnel,
    dropped: { unqualified: droppedUnqualified },
    actions: {
      hotLeads:    hotLeads.filter(n => n && n !== 'undefined' && n !== 'undefined — undefined' && n.trim().length > 2).slice(0, 6),
      stalledDeals: stalledDeals.slice(0, 6),
      followupDue:  followupDue.filter(f => f.name && f.name !== 'undefined' && f.name.trim().length > 2).slice(0, 6),
    },
    sourceBreakdown: sourceMap,
    monthlyTrend,
    totals: { leads: leads.length, deals: deals.length },
    updatedAt: now.toISOString(),
  })
}
