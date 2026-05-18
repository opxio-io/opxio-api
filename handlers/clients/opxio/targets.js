// handlers/clients/opxio/targets.js
// Opxio internal — Revenue Targets strip widget

import { getClientByToken, getNotionToken } from "../../../lib/supabase.js"
import { cacheGet, cacheSet, cacheKey, cacheDelete } from "../../../lib/cache.js"

const TARGETS_DB = 'f25523a33ac043ad876dede7e20c2dfa'

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

const getTitle  = p => (p?.title       || []).map(t => t.plain_text).join('').trim()
const getSelect = p => p?.select?.name  || null
const getStatus = p => p?.status?.name  || null
const getNumber = p => p?.number ?? null
const getDate   = p => p?.date?.start   || null

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
  const ck = cacheKey('opxio:targets', client.id)
  if (req.query.refresh === '1') cacheDelete(ck)
  let cached = cacheGet(ck)

  if (!cached) {
    const pages = await queryAll(TARGETS_DB, NOTION_KEY)
    cacheSet(ck, { pages })
    cached = { data: { pages }, stale: false }
  } else if (cached.stale) {
    queryAll(TARGETS_DB, NOTION_KEY)
      .then(pages => cacheSet(ck, { pages }))
      .catch(console.error)
  }

  const { pages } = cached.data
  const now = new Date()

  // Month filter from query params
  const qMonth = req.query.month !== undefined ? parseInt(req.query.month) : null
  const qYear  = req.query.year  !== undefined ? parseInt(req.query.year)  : null
  const fYear  = qYear  !== null ? qYear  : now.getFullYear()
  const fMonth = qMonth !== null ? qMonth : now.getMonth()
  const fStart = new Date(fYear, fMonth, 1)
  const fEnd   = new Date(fYear, fMonth + 1, 0, 23, 59, 59)

  const targets = []

  for (const page of pages) {
    const p         = page.properties
    const name      = getTitle(p['Target Name'])
    const type      = getSelect(p['Target Type'])
    const period    = getSelect(p['Period'])
    const status    = getStatus(p['Status'])
    const currency  = getSelect(p['Currency'])
    const target    = getNumber(p['Target Value'])
    const actual    = getNumber(p['Actual Value']) ?? 0
    const startDate = getDate(p['Start Date'])
    const endDate   = getDate(p['End Date'])

    if (!name || !type || target === null) continue

    // Filter: target period overlaps with selected month
    if (startDate && endDate) {
      const tStart = new Date(startDate)
      const tEnd   = new Date(endDate)
      if (tStart > fEnd || tEnd < fStart) continue
    }

    const pct = target > 0 ? Math.min(Math.round((actual / target) * 100), 100) : 0

    targets.push({ name, type, period, status, currency, target, actual, pct })
  }

  // Sort by a sensible order
  const ORDER = ['Revenue', 'Deals Closed', 'Leads', 'Meetings Booked', 'Proposals Sent', 'Outreach', 'Other']
  targets.sort((a, b) => {
    const ai = ORDER.indexOf(a.type)
    const bi = ORDER.indexOf(b.type)
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
  })

  return res.status(200).json({
    targets,
    period: { year: fYear, month: fMonth },
    updatedAt: now.toISOString(),
  })
}
