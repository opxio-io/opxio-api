// handlers/clients/nadia-cats/medlog.js
// All active medications for all cats — daily check-off via Last Given Date

import { cacheGet, cacheSet, cacheKey } from "../../../lib/cache.js"
import { notionQueue } from "../../../lib/queue.js"

const NOTION_KEY = process.env.NOTION_API_KEY
const TIMEOUT_MS = 8_000
const MEDS_DB    = 'd6cf8fb4130546cf802765438423509e'
const CATS_DB    = 'ab482fba957f4ac1806ea8e5d3f29c10'

const NOTION_HDR = () => ({
  Authorization: `Bearer ${NOTION_KEY}`,
  'Notion-Version': '2022-06-28',
  'Content-Type': 'application/json',
})

async function notionFetch(url, opts = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    return await notionQueue.add(async () => {
      const r = await fetch(url, { ...opts, signal: ctrl.signal, headers: NOTION_HDR() })
      if (!r.ok) throw new Error(`Notion ${r.status}: ${await r.text()}`)
      return r.json()
    })
  } finally { clearTimeout(timer) }
}

async function queryAll(dbId, filter) {
  let results = [], hasMore = true, cursor
  while (hasMore) {
    const body = { page_size: 100, ...(filter && { filter }), ...(cursor && { start_cursor: cursor }) }
    const d = await notionFetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: 'POST', body: JSON.stringify(body),
    })
    results = results.concat(d.results)
    hasMore = d.has_more
    cursor  = d.next_cursor
  }
  return results
}

const getTitle    = p => (p?.title     || []).map(t => t.plain_text).join('')
const getRich     = p => (p?.rich_text || []).map(t => t.plain_text).join('')
const getSelect   = p => p?.select?.name || null
const getDate     = p => p?.date?.start  || null
const getNumber   = p => p?.number       ?? null
const getRelIds   = p => (p?.relation    || []).map(r => r.id)

function gsDayInfo(startDate) {
  if (!startDate) return null
  const start = new Date(startDate)
  const today = new Date()
  const day   = Math.floor((today - start) / 86400000) + 1
  if (day < 1 || day > 84) return null
  return { day, pct: Math.round((day / 84) * 100), day42: day === 42, day84: day === 84 }
}

export async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(204).end()

  // PATCH /:pageId — mark given (today) or unmark
  if (req.method === 'PATCH') {
    const pageId = req.params?.pageId || req.query?.pageId
    const { given } = req.body || {}
    if (!pageId) return res.status(400).json({ error: 'pageId required' })
    const today = new Date().toISOString().slice(0, 10)
    try {
      await notionFetch(`https://api.notion.com/v1/pages/${pageId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          properties: {
            'Last Given Date': given ? { date: { start: today } } : { date: null },
          }
        }),
      })
      return res.json({ ok: true, given: !!given, date: given ? today : null })
    } catch (e) {
      return res.status(500).json({ error: e.message })
    }
  }

  // GET — all active meds grouped by cat, with given-today status
  const today = new Date().toISOString().slice(0, 10)
  const ck    = cacheKey('nadia-cats:medlog-cats', 'global')

  try {
    // Cache cat names for 10 min
    let catMap = cacheGet(ck)
    if (!catMap) {
      const cats = await queryAll(CATS_DB)
      catMap = {}
      for (const c of cats) {
        catMap[c.id.replace(/-/g, '')] = getTitle(c.properties['Name'])
      }
      cacheSet(ck, catMap, 600_000)
    }

    // Always fresh meds (checkbox state changes)
    const meds = await queryAll(MEDS_DB, {
      property: 'Status', select: { equals: 'Active' }
    })

    // Group by cat
    const byCat = {}
    const catOrder = []

    for (const med of meds) {
      const p        = med.properties
      const catIds   = getRelIds(p['Cat'])
      const catId    = catIds[0]?.replace(/-/g, '') || 'unknown'
      const catName  = catMap[catId] || 'Unknown Cat'
      const lastGiven = getDate(p['Last Given Date'])
      const givenToday = lastGiven === today

      const gsInfo = getSelect(p['Med Category']) === 'GS Treatment'
        ? gsDayInfo(getDate(p['Start Date']))
        : null

      const entry = {
        id:         med.id,
        name:       getTitle(p['Medication Name']),
        category:   getSelect(p['Med Category']),
        dosage:     getRich(p['Dosage']) || getRich(p['GS Concentration']),
        frequency:  getRich(p['Frequency Notes']),
        unit:       getSelect(p['Unit']),
        gsForm:     getSelect(p['GS Form']),
        startDate:  getDate(p['Start Date']),
        endDate:    getDate(p['End Date']),
        lastGiven,
        givenToday,
        gsInfo,
        notes:      getRich(p['Notes']),
        purpose:    getRich(p['For Diagnosis / Treatment']) || getRich(p['Purpose']),
      }

      if (!byCat[catName]) {
        byCat[catName] = []
        catOrder.push({ catName, catId })
      }
      byCat[catName].push(entry)
    }

    // Sort meds: GS first, then by name
    for (const cat of Object.keys(byCat)) {
      byCat[cat].sort((a, b) => {
        if (a.category === 'GS Treatment') return -1
        if (b.category === 'GS Treatment') return 1
        return a.name.localeCompare(b.name)
      })
    }

    const totalMeds  = meds.length
    const givenCount = meds.filter(m => {
      const last = getDate(m.properties['Last Given Date'])
      return last === today
    }).length

    return res.json({ today, byCat, catOrder, totalMeds, givenCount })
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
}
