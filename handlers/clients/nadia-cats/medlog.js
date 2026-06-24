// handlers/clients/nadia-cats/medlog.js
// Medication Daily Log — GET entries by date, PATCH to check off

import { notionQueue } from "../../../lib/queue.js"

const NOTION_KEY = process.env.NOTION_API_KEY
const TIMEOUT_MS = 8_000
const LOG_DB     = 'efb0a61ce3c847afb202043643721767'

const NOTION_HEADERS = () => ({
  Authorization: `Bearer ${NOTION_KEY}`,
  'Notion-Version': '2022-06-28',
  'Content-Type': 'application/json',
})

async function notionFetch(url, opts = {}) {
  const ctrl  = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    return await notionQueue.add(async () => {
      const r = await fetch(url, { ...opts, signal: ctrl.signal, headers: NOTION_HEADERS() })
      if (!r.ok) throw new Error(`Notion ${r.status}: ${await r.text()}`)
      return r.json()
    })
  } finally {
    clearTimeout(timer)
  }
}

const getTitle    = p => (p?.title    || []).map(t => t.plain_text).join('')
const getSelect   = p => p?.select?.name || null
const getDate     = p => p?.date?.start  || null
const getNumber   = p => p?.number       ?? null
const getCheckbox = p => p?.checkbox     === true
const getRelIds   = p => (p?.relation    || []).map(r => r.id)

export async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(204).end()

  // PATCH — toggle checkbox
  if (req.method === 'PATCH') {
    const pageId = req.params?.pageId || req.query?.pageId
    const { given } = req.body || {}
    if (!pageId) return res.status(400).json({ error: 'pageId required' })
    try {
      await notionFetch(`https://api.notion.com/v1/pages/${pageId}`, {
        method: 'PATCH',
        body: JSON.stringify({ properties: { 'Given ✅': { checkbox: !!given } } }),
      })
      return res.json({ ok: true, given: !!given })
    } catch (e) {
      return res.status(500).json({ error: e.message })
    }
  }

  // GET — entries for a date
  const date = req.query?.date || new Date().toISOString().slice(0, 10)
  try {
    const data = await notionFetch(`https://api.notion.com/v1/databases/${LOG_DB}/query`, {
      method: 'POST',
      body: JSON.stringify({
        filter: { property: 'Date', date: { equals: date } },
        sorts:  [{ property: 'Log Entry', direction: 'ascending' }],
        page_size: 50,
      }),
    })

    const entries = data.results.map(page => {
      const p = page.properties
      return {
        id:        page.id,
        title:     getTitle(p['Log Entry']),
        date:      getDate(p['Date']),
        dayNum:    getNumber(p['Day #']),
        given:     getCheckbox(p['Given ✅']),
        milestone: getSelect(p['Milestone']),
        catIds:    getRelIds(p['Cat']),
        medIds:    getRelIds(p['Medication']),
        notes:     (p['Notes']?.rich_text || []).map(t => t.plain_text).join(''),
      }
    })

    const byCat = {}
    for (const e of entries) {
      const catName = e.title.split(' · ')[0] || 'Unknown'
      if (!byCat[catName]) byCat[catName] = []
      byCat[catName].push(e)
    }

    return res.json({ date, entries, byCat })
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
}
