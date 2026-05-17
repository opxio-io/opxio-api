// handlers/clients/opxio/sales-pipeline.js
// Opxio internal — Sales Pipeline widget
// Leads DB: 340fe60097f6810091cfe204a1c13f5f
// Deals DB:  caafe60097f683398df40197eeedbffe

import { getClientByToken, getNotionToken, cacheGet, cacheSet, cacheKey } from "../../../lib/supabase.js"
import { cacheGet as cGet, cacheSet as cSet, cacheKey as cKey } from "../../../lib/cache.js"

const LEADS_DB = '340fe60097f6810091cfe204a1c13f5f'
const DEALS_DB  = 'caafe60097f683398df40197eeedbffe'

const LEAD_STAGE_ORDER = ['New Lead','Contacted','Discovery Booked','Discovery Done','Qualified','Needs Review']
const LEAD_OPEN        = new Set(LEAD_STAGE_ORDER)

const DEAL_STAGE_ORDER = ['Discovery Done','Proposal Sent','Quotation Sent','Negotiation','Closed-Won']
const DEAL_OPEN        = new Set(['Discovery Done','Proposal Sent','Quotation Sent','Negotiation'])

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

const getTitle  = p => (p?.title     || []).map(t => t.plain_text).join('')
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

  const ck = cKey('opxio:sales-pipeline', client.id)
  let cached = cGet(ck)

  if (!cached || cached.stale) {
    // Fetch in background if stale, serve immediately
    if (!cached) {
      // Hard miss — fetch synchronously
      const [leads, deals] = await Promise.all([
        queryAll(LEADS_DB, NOTION_KEY),
        queryAll(DEALS_DB,  NOTION_KEY),
      ])
      cached = { data: { leads, deals } }
      cSet(ck, { leads, deals })
    } else {
      // Stale — refresh in background
      Promise.all([
        queryAll(LEADS_DB, NOTION_KEY),
        queryAll(DEALS_DB,  NOTION_KEY),
      ]).then(([leads, deals]) => cSet(ck, { leads, deals })).catch(console.error)
    }
  }

  const { leads, deals } = cached.data || cached

  const now    = new Date()
  const today  = now.toISOString().slice(0, 10)
  const mStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const mEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0)
  const staleThreshold = new Date(now - 7 * 24 * 60 * 60 * 1000)

  // Parse month filter
  const qMonth = req.query.month !== undefined ? parseInt(req.query.month) : null
  const qYear  = req.query.year  !== undefined ? parseInt(req.query.year)  : null
  const fStart = (qMonth !== null && qYear !== null)
    ? new Date(qYear, qMonth, 1)
    : mStart
  const fEnd   = (qMonth !== null && qYear !== null)
    ? new Date(qYear, qMonth + 1, 0)
    : mEnd

  // ── Lead metrics ──────────────────────────────────────────────────────────
  let openLeads = 0, hotLeads = 0, convertedMTD = 0
  const leadsByStage  = {}
  const sourceCount   = {}
  const hotLeadNames  = []
  const followupLeads = []

  for (const page of leads) {
    const p     = page.properties
    const stage = getStatus(p['Stage'])
    const qual  = getStatus(p['Qualification Score'])
    const name  = getTitle(p['Lead Name'])
    const created = page.created_time
    const lastFU  = getDate(p['Last Follow-Up'])
    const sources = getMulti(p['Source'])

    if (!stage) continue

    // Funnel counts (all stages)
    leadsByStage[stage] = (leadsByStage[stage] || 0) + 1

    // Source breakdown (open leads only)
    if (LEAD_OPEN.has(stage)) {
      openLeads++
      if (qual === 'Hot') {
        hotLeads++
        hotLeadNames.push(name)
      }
      // Follow-up overdue
      if (lastFU && lastFU <= today) {
        followupLeads.push({ name, lastFU })
      }
      // Source
      for (const src of sources) {
        sourceCount[src] = (sourceCount[src] || 0) + 1
      }
    }

    // Converted this month
    if (stage === 'Converted' && created) {
      const d = new Date(created)
      if (d >= fStart && d <= fEnd) convertedMTD++
    }
  }

  // ── Deal metrics ──────────────────────────────────────────────────────────
  let openDeals = 0, pipelineValue = 0, closedWonMTD = 0
  const dealsByStage = {}
  const stalledDeals = []

  for (const page of deals) {
    const p         = page.properties
    const stage     = getStatus(p['Stage'])
    const name      = getTitle(p['Deal Name'])
    const estValue  = getNumber(p['Estimated Value'])
    const closeDate = getDate(p['Actual Close Date'])
    const lastEdit  = new Date(page.last_edited_time)
    const osComb    = getMulti(p['OS Combination'])

    if (!stage) continue

    dealsByStage[stage] = (dealsByStage[stage] || 0) + 1

    if (DEAL_OPEN.has(stage)) {
      openDeals++
      if (estValue) pipelineValue += estValue
      // Stalled: last edited > 7 days ago
      if (lastEdit < staleThreshold) {
        const daysStale = Math.floor((now - lastEdit) / (24 * 60 * 60 * 1000))
        stalledDeals.push({ name, stage, daysStale, os: osComb.join(' + ') || '—' })
      }
    }

    if (stage === 'Closed-Won') {
      const ref = closeDate ? new Date(closeDate) : new Date(page.created_time)
      if (ref >= fStart && ref <= fEnd) closedWonMTD++
    }
  }

  // Build ordered funnels
  const leadFunnel = LEAD_STAGE_ORDER.map(s => ({ stage: s, count: leadsByStage[s] || 0 }))
  const dealFunnel = DEAL_STAGE_ORDER.map(s => ({ stage: s, count: dealsByStage[s] || 0 }))

  // Conversion rate: converted / (converted + unqualified + open)
  const totalLeads = leads.length
  const convRate   = totalLeads > 0
    ? Math.round(((leadsByStage['Converted'] || 0) / totalLeads) * 100)
    : null

  stalledDeals.sort((a, b) => b.daysStale - a.daysStale)

  return res.status(200).json({
    kpi: {
      openLeads,
      openDeals,
      pipelineValue: Math.round(pipelineValue),
      closedWonMTD,
      hotLeads,
      convRate,
    },
    leadFunnel,
    dealFunnel,
    actions: {
      hotLeads: hotLeadNames.slice(0, 5),
      stalledDeals: stalledDeals.slice(0, 5),
      followupLeads: followupLeads.slice(0, 5),
    },
    sourceBreakdown: sourceCount,
    totals: { leads: totalLeads, deals: deals.length },
    updatedAt: now.toISOString(),
  })
}
