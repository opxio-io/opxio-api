// ─── qc-review.js ─────────────────────────────────────────────────────────
// GET /api/clients/opxio/qc-review?token=&status=
// Auth: session JWT (from Notion OAuth) OR widget access token.
//
// session=<jwt>   — reviewer personal session (issued by auth-callback)
// token=<token>   — widget token (Supabase, fallback / programmatic)

import { getClientByToken }        from '../../../lib/supabase.js'
import { verifySession }           from '../../../lib/session.js'

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

  // ── Auth: session JWT (preferred) or widget token ──────────────────────
  const sessionToken = req.query.session || req.headers['x-session-token']
  const widgetToken  = req.query.token   || req.headers['x-widget-token']
  let   reviewer     = null

  if (sessionToken) {
    try {
      const sess = verifySession(sessionToken)
      reviewer   = sess.email
      // session is valid — no need to hit Supabase
    } catch (err) {
      return res.status(401).json({ error: 'Session expired or invalid', detail: err.message })
    }
  } else if (widgetToken) {
    const client = await getClientByToken(widgetToken)
    if (!client) return res.status(403).json({ error: 'Invalid widget token' })
    // widget token auth — no reviewer identity
  } else {
    return res.status(401).json({ error: 'Authentication required', hint: 'Provide session= (JWT) or token= (widget token)' })
  }

  try {
    const status = req.query.status || null
    const items  = await fetchQcItems(status === 'all' ? null : status)
    return res.status(200).json({
      ok:       true,
      count:    items.length,
      reviewer: reviewer || null,
      items:    items.map(parseQcItem),
    })
  } catch (err) {
    console.error('[qc-review]', err)
    return res.status(500).json({ error: err.message || 'Internal error' })
  }
}
