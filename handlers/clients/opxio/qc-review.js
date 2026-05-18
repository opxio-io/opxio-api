// ─── qc-review.js ─────────────────────────────────────────────────────────
// GET /api/opxio/qc-review?token=&status=   → list QC items (read-only)
// Actions (approve/reject/revision) are handled by qc-action.js via Notion buttons.

import { getClientByToken }            from '../../../lib/supabase.js'

const QC_DB  = 'e9f3b2e857b3470d8d8bef749737d99b'
const KEY    = () => process.env.NOTION_API_KEY

function hdrs() {
  return {
    Authorization:    `Bearer ${KEY()}`,
    'Notion-Version': '2022-06-28',
    'Content-Type':   'application/json',
  }
}

const getSelect  = p => p?.select?.name  || null
const getNum     = p => typeof p?.number === 'number' ? p.number : null
const getDate    = p => p?.date?.start   || null
const getRelIds  = p => (p?.relation     || []).map(r => r.id)
const getRichTxt = p => (p?.rich_text    || []).map(t => t.plain_text).join('').trim()
const getTitleStr = props => {
  const tp = Object.values(props || {}).find(v => v.type === 'title')
  return (tp?.title || []).map(t => t.plain_text).join('').trim()
}

async function fetchQcItems(statusFilter) {
  const filter = statusFilter
    ? { property: 'Review Status', select: { equals: statusFilter } }
    : undefined

  let results = [], hasMore = true, cursor
  while (hasMore) {
    const body = {
      page_size: 100,
      sorts: [{ property: 'Submitted At', direction: 'descending' }],
    }
    if (filter) body.filter = filter
    if (cursor) body.start_cursor = cursor
    const r = await fetch(`https://api.notion.com/v1/databases/${QC_DB}/query`, {
      method: 'POST', headers: hdrs(), body: JSON.stringify(body),
    })
    if (!r.ok) throw new Error(await r.text())
    const d = await r.json()
    results = results.concat(d.results)
    hasMore = d.has_more
    cursor  = d.next_cursor
  }
  return results
}

function parseQcItem(page) {
  const p = page.properties || {}
  return {
    id:                page.id,
    url:               page.url,
    name:              getTitleStr(p) || page.id,
    type:              getSelect(p.Type),
    reviewStatus:      getSelect(p['Review Status']),
    submittedAt:       getDate(p['Submitted At']),
    reviewedAt:        getDate(p['Reviewed At']),
    reviewedBy:        getRichTxt(p['Reviewed By']),
    reviewerNotes:     getRichTxt(p['Reviewer Notes']),
    qcRound:           getNum(p['QC Round'])   || 1,
    amount:            getNum(p.Amount)        || 0,
    currency:          getSelect(p.Currency)   || 'MYR',
    entityName:        getRichTxt(p['Entity Name']),
    quoteType:         getSelect(p['Quote Type']),
    linkedQuoteIds:    getRelIds(p['Linked Quotation']),
    linkedProposalIds: getRelIds(p['Linked Proposal']),
  }
}

export async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET')     return res.status(405).json({ error: 'GET only' })

  const token = req.query.token || req.headers['x-widget-token']
  if (!token) return res.status(401).json({ error: 'Missing token' })
  const client = await getClientByToken(token)
  if (!client) return res.status(403).json({ error: 'Invalid token' })

  try {
    const status = req.query.status || null
    const items  = await fetchQcItems(status === 'all' ? null : status)
    return res.status(200).json({ ok: true, count: items.length, items: items.map(parseQcItem) })
  } catch (err) {
    console.error('[qc-review]', err)
    return res.status(500).json({ error: err.message || 'Internal error' })
  }
}
