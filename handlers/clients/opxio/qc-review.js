// ─── qc-review.js ─────────────────────────────────────────────────────────
// Reviewer-only QC endpoint. Auth: widget token + verified Notion OAuth session.
//
// GET  /api/opxio/qc-review?token=&session=    → list QC items
// POST /api/opxio/qc-review?token=&session=    → approve / reject / revision
//
// POST body: { qc_id, action: 'approve'|'reject'|'revision', notes? }
//
// Session token is issued by /api/opxio/oauth/callback after Notion OAuth.
// It encodes { email, clientId } and is signed with JWT_SECRET.

import { getClientByToken, getNotionToken } from '../../../lib/supabase.js'
import { getPage, patchPage, plain, DB }    from '../../../lib/notion.js'
import { verifySession }                    from '../../../lib/session.js'

const QC_DB        = 'e9f3b2e857b3470d8d8bef749737d99b'
const QUOTES_DB    = DB.QUOTATIONS
const PROPOSALS_DB = DB.PROPOSALS

const NOTION_KEY = () => process.env.NOTION_API_KEY

function hdrs() {
  return {
    Authorization:    `Bearer ${NOTION_KEY()}`,
    'Notion-Version': '2022-06-28',
    'Content-Type':   'application/json',
  }
}

const getSelect  = p => p?.select?.name  || null
const getStatus  = p => p?.status?.name  || p?.select?.name || null
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
    const body = { page_size: 100, sorts: [{ property: 'Submitted At', direction: 'descending' }] }
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
    name:              getTitleStr(p) || page.id,
    type:              getSelect(p.Type),
    reviewStatus:      getSelect(p['Review Status']),
    submittedAt:       getDate(p['Submitted At']),
    reviewedAt:        getDate(p['Reviewed At']),
    reviewedBy:        getRichTxt(p['Reviewed By']),
    qcRound:           getNum(p['QC Round'])     || 1,
    amount:            getNum(p.Amount)          || 0,
    currency:          getSelect(p.Currency)     || 'MYR',
    entityName:        getRichTxt(p['Entity Name']),
    quoteType:         getSelect(p['Quote Type']),
    reviewerNotes:     getRichTxt(p['Reviewer Notes']),
    linkedQuoteIds:    getRelIds(p['Linked Quotation']),
    linkedProposalIds: getRelIds(p['Linked Proposal']),
  }
}

async function addComment(pageId, text) {
  try {
    await fetch('https://api.notion.com/v1/comments', {
      method: 'POST', headers: hdrs(),
      body: JSON.stringify({
        parent:    { page_id: pageId },
        rich_text: [{ text: { content: text } }],
      }),
    })
  } catch (_) {}
}

// ─── GET ──────────────────────────────────────────────────────────────────
async function handleGet(req, res) {
  const status = req.query.status || 'Pending Review'
  const items  = await fetchQcItems(status === 'all' ? null : status)
  return res.status(200).json({ ok: true, count: items.length, items: items.map(parseQcItem) })
}

// ─── POST ─────────────────────────────────────────────────────────────────
async function handlePost(req, res, reviewerEmail) {
  const { qc_id, action, notes = '' } = req.body || {}
  if (!qc_id)  return res.status(400).json({ error: 'Missing qc_id' })
  if (!action) return res.status(400).json({ error: 'Missing action' })
  if (!['approve', 'reject', 'revision'].includes(action))
    return res.status(400).json({ error: 'action must be: approve, reject, or revision' })

  const qcPage  = await getPage(qc_id, NOTION_KEY())
  const qcItem  = parseQcItem(qcPage)

  if (qcItem.reviewStatus !== 'Pending Review') {
    return res.status(409).json({
      error: `QC record is already "${qcItem.reviewStatus}". Only Pending Review items can be actioned.`,
    })
  }

  const isQuote   = qcItem.type === 'Quotation'
  const sourceId  = (isQuote ? qcItem.linkedQuoteIds : qcItem.linkedProposalIds)[0]
  if (!sourceId)
    return res.status(400).json({ error: `No linked ${isQuote ? 'Quotation' : 'Proposal'} on this QC record` })

  const now    = new Date().toISOString()
  const nowFmt = new Date().toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur' })

  let qcStatus, sourceStatusPatch, commentText

  if (action === 'approve') {
    qcStatus          = 'Approved'
    sourceStatusPatch = { Status: { status: { name: isQuote ? 'Approved' : 'Accepted' } } }
    commentText       = `✅ QC Approved by ${reviewerEmail} — ${nowFmt} MYT${notes ? `\n\nNotes: ${notes}` : ''}`
  } else if (action === 'reject') {
    qcStatus          = 'Rejected'
    sourceStatusPatch = { Status: { status: { name: 'Draft' } } }
    commentText       = `❌ QC Rejected by ${reviewerEmail} — ${nowFmt} MYT\n\nNotes: ${notes || '(none)'}`
  } else {
    qcStatus          = 'Revision Requested'
    sourceStatusPatch = null
    commentText       = `🔄 Revision Requested by ${reviewerEmail} — ${nowFmt} MYT\n\nNotes: ${notes || '(none)'}`
  }

  // Update QC record
  await patchPage(qc_id, {
    'Review Status':  { select:     { name: qcStatus } },
    'Reviewed At':    { date:       { start: now } },
    'Reviewed By':    { rich_text:  [{ text: { content: reviewerEmail } }] },
    'Reviewer Notes': { rich_text:  [{ text: { content: notes } }] },
  }, NOTION_KEY())

  // Patch source doc (status + QC Status)
  const qcStatusPatch = { 'QC Status': { select: { name: qcStatus } } }
  if (sourceStatusPatch) {
    await patchPage(sourceId, { ...sourceStatusPatch, ...qcStatusPatch }, NOTION_KEY())
  } else {
    await patchPage(sourceId, qcStatusPatch, NOTION_KEY())
  }

  // Add comment on source
  await addComment(sourceId, commentText)

  return res.status(200).json({
    ok: true, action, qcId: qc_id, qcRef: qcItem.name,
    qcStatus, sourceId, type: qcItem.type, reviewedBy: reviewerEmail,
  })
}

// ─── Main export ──────────────────────────────────────────────────────────
export async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()

  // Standard widget token auth
  const token = req.query.token || req.headers['x-widget-token']
  if (!token) return res.status(401).json({ error: 'Missing token' })
  const client = await getClientByToken(token)
  if (!client) return res.status(403).json({ error: 'Invalid token' })

  // Session auth — must be a valid signed session for this client
  const sessionStr = req.query.session || req.body?.session || req.headers['x-session']
  if (!sessionStr) return res.status(401).json({ error: 'Missing session — authenticate via Notion OAuth first', needsAuth: true })

  let session
  try {
    session = verifySession(sessionStr)
  } catch (err) {
    return res.status(401).json({ error: err.message, needsAuth: true })
  }

  // Session must belong to this client
  if (session.clientId !== client.id) {
    return res.status(403).json({ error: 'Session does not match widget token', needsAuth: true })
  }

  try {
    if (req.method === 'GET')       return await handleGet(req, res)
    else if (req.method === 'POST') return await handlePost(req, res, session.email)
    else return res.status(405).json({ error: 'GET or POST only' })
  } catch (err) {
    console.error('[qc-review]', err)
    return res.status(500).json({ error: err.message || 'Internal error' })
  }
}
