// ─── qc-action.js ─────────────────────────────────────────────────────────
// POST /api/opxio/qc-action?token=<widget_token>&action=<approve|reject|revision>
//
// Triggered by Notion button on QC Approval Tracker record.
// Notion automatically sends body.source.user_id — no login needed.
//
// To use: add Approve / Reject / Revision Requested buttons to QC DB in Notion.
// Each button fires:
//   POST https://api.opxio.io/api/opxio/qc-action?token=TOKEN&action=approve
//   Body: { "page_id": "{{page_id}}" }
//
// For reject/revision: reviewer fills in "Reviewer Notes" field on the record
// before clicking the button — the API reads it from the page properties.

import { getClientByToken }               from '../../../lib/supabase.js'
import { getPage, patchPage, DB }         from '../../../lib/notion.js'

const QC_DB        = 'e9f3b2e857b3470d8d8bef749737d99b'
const QUOTES_DB    = DB.QUOTATIONS
const PROPOSALS_DB = DB.PROPOSALS

const KEY = () => process.env.NOTION_API_KEY

function hdrs() {
  return {
    Authorization:    `Bearer ${KEY()}`,
    'Notion-Version': '2022-06-28',
    'Content-Type':   'application/json',
  }
}

// Resolve reviewer email from Notion user_id
async function resolveReviewer(userId) {
  if (!userId) return 'Unknown'
  try {
    const r = await fetch(`https://api.notion.com/v1/users/${userId}`, { headers: hdrs() })
    if (!r.ok) return 'Unknown'
    const u = await r.json()
    return u?.person?.email || u?.name || 'Unknown'
  } catch { return 'Unknown' }
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

const getSelect  = p => p?.select?.name  || null
const getRelIds  = p => (p?.relation     || []).map(r => r.id)
const getRichTxt = p => (p?.rich_text    || []).map(t => t.plain_text).join('').trim()
const getTitleStr = props => {
  const tp = Object.values(props || {}).find(v => v.type === 'title')
  return (tp?.title || []).map(t => t.plain_text).join('').trim()
}

export async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST')    return res.status(405).json({ error: 'POST only' })

  const token = req.query.token || req.headers['x-widget-token']
  if (!token) return res.status(401).json({ error: 'Missing token' })
  const client = await getClientByToken(token)
  if (!client) return res.status(403).json({ error: 'Invalid token' })

  const action = req.query.action
  if (!['approve', 'reject', 'revision'].includes(action))
    return res.status(400).json({ error: 'action must be: approve, reject, or revision' })

  // Notion button payload
  const userId = req.body?.source?.user_id
  const pageId = req.body?.page_id || req.body?.data?.id
  if (!pageId)  return res.status(400).json({ error: 'Missing page_id' })

  const reviewerEmail = await resolveReviewer(userId)

  try {
    const qcPage = await getPage(pageId, KEY())
    const props  = qcPage.properties || {}

    const reviewStatus = getSelect(props['Review Status'])
    const type         = getSelect(props['Type'])
    const notes        = getRichTxt(props['Reviewer Notes'])
    const qcName       = getTitleStr(props)
    const isQuote      = type === 'Quotation'
    const sourceId     = (isQuote
      ? getRelIds(props['Linked Quotation'])
      : getRelIds(props['Linked Proposal']))[0]

    if (!sourceId)
      return res.status(400).json({ error: `No linked ${isQuote ? 'Quotation' : 'Proposal'} found` })

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
    await patchPage(pageId, {
      'Review Status': { select:    { name: qcStatus } },
      'Reviewed At':   { date:      { start: now } },
      'Reviewed By':   { rich_text: [{ text: { content: reviewerEmail } }] },
    }, KEY())

    // Patch source doc: status + QC Status
    const qcStatusPatch = { 'QC Status': { select: { name: qcStatus } } }
    await patchPage(sourceId, sourceStatusPatch
      ? { ...sourceStatusPatch, ...qcStatusPatch }
      : qcStatusPatch
    , KEY())

    // Comment on source
    await addComment(sourceId, commentText)

    return res.status(200).json({
      ok: true, action, qcId: pageId, qcRef: qcName,
      qcStatus, sourceId, type, reviewedBy: reviewerEmail,
    })

  } catch (err) {
    console.error('[qc-action]', err)
    return res.status(500).json({ error: err.message || 'Action failed' })
  }
}
