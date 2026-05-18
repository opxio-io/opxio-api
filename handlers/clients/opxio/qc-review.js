// ─── qc-review.js ─────────────────────────────────────────────────────────
// Reviewer-only QC endpoint. Protected by ?reviewer_key=<QC_REVIEWER_SECRET>
// in addition to the standard ?token= widget auth.
//
// GET  /api/opxio/qc-review?token=&reviewer_key=        → list pending QC items
// POST /api/opxio/qc-review?token=&reviewer_key=        → perform review action
//
// POST body: { qc_id, action: 'approve'|'reject'|'revision', notes?, reviewer_name? }
//
// approve  → flip source: Quotation → Approved, Proposal → Accepted
//            update QC record: Review Status → Approved, Reviewed At → now
// reject   → flip source status → Draft, add Notion comment with notes
//            update QC record: Review Status → Rejected
// revision → update QC record: Review Status → Revision Requested
//            add Notion comment with notes (source stays at current status)

import { getClientByToken, getNotionToken } from '../../../lib/supabase.js'
import { getPage, patchPage, plain, DB } from '../../../lib/notion.js'

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

function checkReviewerKey(req) {
  const secret = process.env.QC_REVIEWER_SECRET
  if (!secret) return false // if not set, block all access
  const provided = req.query.reviewer_key || req.body?.reviewer_key
  return provided === secret
}

// Fetch all QC records matching optional status filter
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
  const p    = page.properties || {}
  const name = getTitleStr(p) || page.id
  return {
    id:           page.id,
    name,
    type:         getSelect(p.Type),
    reviewStatus: getSelect(p['Review Status']),
    submittedAt:  getDate(p['Submitted At']),
    reviewedAt:   getDate(p['Reviewed At']),
    qcRound:      getNum(p['QC Round'])    || 1,
    amount:       getNum(p.Amount)         || 0,
    currency:     getSelect(p.Currency)    || 'MYR',
    entityName:   getRichTxt(p['Entity Name']),
    quoteType:    getSelect(p['Quote Type']),
    reviewerNotes:getRichTxt(p['Reviewer Notes']),
    linkedQuoteIds:   getRelIds(p['Linked Quotation']),
    linkedProposalIds:getRelIds(p['Linked Proposal']),
  }
}

// Add a Notion comment to a page
async function addComment(pageId, text) {
  try {
    await fetch('https://api.notion.com/v1/comments', {
      method: 'POST',
      headers: hdrs(),
      body: JSON.stringify({
        parent:     { page_id: pageId },
        rich_text:  [{ text: { content: text } }],
      }),
    })
  } catch (_) { /* non-fatal */ }
}

// ─── GET Handler ──────────────────────────────────────────────────────────
async function handleGet(req, res) {
  const status = req.query.status || 'Pending Review' // default: pending only
  const items  = await fetchQcItems(status === 'all' ? null : status)
  return res.status(200).json({
    ok:    true,
    count: items.length,
    items: items.map(parseQcItem),
  })
}

// ─── POST Handler ─────────────────────────────────────────────────────────
async function handlePost(req, res) {
  const { qc_id, action, notes = '', reviewer_name = 'Reviewer' } = req.body || {}
  if (!qc_id)  return res.status(400).json({ error: 'Missing qc_id' })
  if (!action) return res.status(400).json({ error: 'Missing action (approve/reject/revision)' })
  if (!['approve', 'reject', 'revision'].includes(action))
    return res.status(400).json({ error: 'action must be: approve, reject, or revision' })

  // Fetch QC record
  const qcPage = await getPage(qc_id, NOTION_KEY())
  const qcProps = qcPage.properties || {}
  const qcItem  = parseQcItem(qcPage)

  if (qcItem.reviewStatus !== 'Pending Review') {
    return res.status(409).json({
      error: `QC record is already "${qcItem.reviewStatus}". Only "Pending Review" items can be actioned.`,
    })
  }

  const isQuote   = qcItem.type === 'Quotation'
  const sourceIds = isQuote ? qcItem.linkedQuoteIds : qcItem.linkedProposalIds
  const sourceId  = sourceIds[0]

  if (!sourceId) {
    return res.status(400).json({ error: `QC record has no linked ${isQuote ? 'Quotation' : 'Proposal'}` })
  }

  const now     = new Date().toISOString()
  const nowFmt  = new Date().toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur' })
  let   qcStatus, sourceStatusPatch, commentText

  if (action === 'approve') {
    qcStatus          = 'Approved'
    const approvedVal = isQuote ? 'Approved' : 'Accepted'
    sourceStatusPatch = { Status: { status: { name: approvedVal } } }
    commentText       = `✅ QC Approved by ${reviewer_name} — ${nowFmt} MYT${notes ? `\n\nNotes: ${notes}` : ''}`

  } else if (action === 'reject') {
    qcStatus          = 'Rejected'
    sourceStatusPatch = { Status: { status: { name: 'Draft' } } }
    commentText       = `❌ QC Rejected by ${reviewer_name} — ${nowFmt} MYT\n\nNotes: ${notes || '(no notes provided)'}`

  } else { // revision
    qcStatus          = 'Revision Requested'
    sourceStatusPatch = null // don't change source status — leave for team to address
    commentText       = `🔄 QC Revision Requested by ${reviewer_name} — ${nowFmt} MYT\n\nNotes: ${notes || '(no notes provided)'}`
  }

  // Update QC record
  const qcPatchProps = {
    'Review Status':  { select: { name: qcStatus } },
    'Reviewed At':    { date:   { start: now } },
    'Reviewer Notes': { rich_text: [{ text: { content: notes } }] },
  }
  await patchPage(qc_id, qcPatchProps, NOTION_KEY())

  // Patch source document
  if (sourceStatusPatch) {
    await patchPage(sourceId, sourceStatusPatch, NOTION_KEY())
  }

  // Add Notion comment on source
  await addComment(sourceId, commentText)

  return res.status(200).json({
    ok:       true,
    action,
    qcId:     qc_id,
    qcRef:    qcItem.name,
    qcStatus,
    sourceId,
    type:     qcItem.type,
  })
}

// ─── Main export ──────────────────────────────────────────────────────────
export async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()

  // Standard token auth
  const token = req.query.token || req.headers['x-widget-token']
  if (!token) return res.status(401).json({ error: 'Missing token' })
  const client = await getClientByToken(token)
  if (!client) return res.status(403).json({ error: 'Invalid token' })

  // Extra reviewer-key check
  if (!checkReviewerKey(req)) {
    return res.status(403).json({ error: 'Access denied — reviewer_key required' })
  }

  try {
    if (req.method === 'GET')       return await handleGet(req, res)
    else if (req.method === 'POST') return await handlePost(req, res)
    else return res.status(405).json({ error: 'GET or POST only' })
  } catch (err) {
    console.error('[qc-review]', err)
    return res.status(500).json({ error: err.message || 'Internal error' })
  }
}
