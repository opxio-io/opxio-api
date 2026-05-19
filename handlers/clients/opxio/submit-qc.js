// ─── submit-qc.js ─────────────────────────────────────────────────────────
// POST /api/clients/opxio/submit-qc
// Triggered by Notion button on Quotations or Proposals DB.
//
// Notion button webhook body shape (confirmed):
//   body.data.id          — page ID (with dashes)
//   body.data.parent      — { type: "database_id", database_id: "..." }
//   body.data.properties  — full page properties
//   body.page_id          — may be "{{page_id}}" (uninterpolated) or the real ID
//
// Flow:
//   1. Extract page_id from body.data.id (primary) or body.page_id (fallback)
//   2. Fetch page if body.data doesn't include full properties
//   3. Detect type (Quotation vs Proposal) via parent DB ID
//   4. Validate status is eligible
//   5. Create QC Approval Tracker record
//   6. Set Review Status on source page
//   7. Comment on source page

import { getPage, patchPage, createPage, plain, DB } from '../../../lib/notion.js'

const QC_DB        = 'e9f3b2e857b3470d8d8bef749737d99b'
const QUOTES_DB    = DB.QUOTATIONS   // 'b54fe60097f683e1930d012d635b14d5'
const PROPOSALS_DB = DB.PROPOSALS    // '1ad661f2679047749d16d2767291a30f'

// Statuses eligible for QC submission
const ELIGIBLE_QUOTE_STATUSES    = new Set(['Draft', 'Ready to Send', 'Sent'])
const ELIGIBLE_PROPOSAL_STATUSES = new Set(['Draft', 'Ready to Send', 'Sent'])

// Normalise Quote Type names between source DBs and QC DB
// Quotations DB uses "Add-on" (lowercase o); QC DB uses "Add-On"
const QUOTE_TYPE_MAP = {
  'Add-on': 'Add-On',
}
function normaliseQuoteType(qt) {
  if (!qt) return null
  return QUOTE_TYPE_MAP[qt] || qt
}

const NOTION_KEY = () => process.env.NOTION_API_KEY

function hdrs() {
  return {
    Authorization:    `Bearer ${NOTION_KEY()}`,
    'Notion-Version': '2022-06-28',
    'Content-Type':   'application/json',
  }
}

const getSelect   = p => p?.select?.name   || null
const getStatus   = p => p?.status?.name   || p?.select?.name || null
const getNum      = p => typeof p?.number === 'number' ? p.number : null
const getRelIds   = p => (p?.relation      || []).map(r => r.id)
const getTitleStr = props => {
  const tp = Object.values(props || {}).find(v => v.type === 'title')
  return (tp?.title || []).map(t => t.plain_text).join('').trim()
}

// Count existing QC rounds for this source page
async function getQcRound(sourcePageId, relField) {
  try {
    const res = await fetch(`https://api.notion.com/v1/databases/${QC_DB}/query`, {
      method: 'POST',
      headers: hdrs(),
      body: JSON.stringify({
        filter: { property: relField, relation: { contains: sourcePageId } },
        page_size: 100,
      }),
    })
    if (!res.ok) return 1
    const d = await res.json()
    return (d.results?.length || 0) + 1
  } catch { return 1 }
}

export async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  // ── Extract page_id ──────────────────────────────────────────────────────
  // Priority: body.data.id → body.page_id (if not a template placeholder)
  const bodyDataId = (req.body?.data?.id || '').replace(/-/g, '')
  const rawId      = req.body?.page_id
  const isTemplate = typeof rawId === 'string' && rawId.startsWith('{{')
  const fromBody   = (!rawId || isTemplate)
    ? bodyDataId
    : rawId.replace(/-/g, '')
  const page_id = fromBody || ''

  console.log('[submit-qc] body keys:', Object.keys(req.body || {}))
  console.log('[submit-qc] page_id resolved:', page_id)
  console.log('[submit-qc] body.data.id:', req.body?.data?.id)
  console.log('[submit-qc] body.page_id:', req.body?.page_id)

  if (!page_id) {
    return res.status(400).json({
      error:   'Missing page_id',
      hint:    'Expected body.data.id or body.page_id (non-template)',
      received: {
        bodyKeys:    Object.keys(req.body || {}),
        'data.id':   req.body?.data?.id,
        'page_id':   req.body?.page_id,
      },
    })
  }

  try {
    // ── Fetch page ──────────────────────────────────────────────────────────
    // Use body.data directly if it has the full page shape; otherwise fetch
    const page = (req.body?.data?.properties && req.body?.data?.parent)
      ? req.body.data
      : await getPage(page_id, NOTION_KEY())

    const parentDbId = (page?.parent?.database_id || '').replace(/-/g, '')
    console.log('[submit-qc] parentDbId:', parentDbId)

    // ── Detect type ─────────────────────────────────────────────────────────
    let type
    if      (parentDbId === QUOTES_DB)    type = 'quotation'
    else if (parentDbId === PROPOSALS_DB) type = 'proposal'
    else {
      return res.status(400).json({
        error:    `Page is not in Quotations or Proposals DB`,
        parentId: parentDbId,
        expected: { quotations: QUOTES_DB, proposals: PROPOSALS_DB },
      })
    }

    const isQuote = type === 'quotation'
    const props   = page.properties || {}

    const status    = getStatus(props.Status)
    const amount    = getNum(props.Amount)      || 0
    const currency  = getSelect(props.Currency) || 'MYR'
    // Proposals use "Proposal Type" field; Quotations use "Quote Type"
    const quoteType = normaliseQuoteType(
      isQuote
        ? getSelect(props['Quote Type'])
        : getSelect(props['Proposal Type'])
    )
    const refNo = getTitleStr(props) || page_id

    // ── Validate status ─────────────────────────────────────────────────────
    const eligible = isQuote ? ELIGIBLE_QUOTE_STATUSES : ELIGIBLE_PROPOSAL_STATUSES
    if (status && !eligible.has(status)) {
      return res.status(400).json({
        error:   `Cannot submit for QC: current status is "${status}"`,
        allowed: [...eligible],
        type,
      })
    }

    // ── Resolve entity name via Client relation ──────────────────────────────
    // Both Quotations and Proposals use "Client" (relation to Companies DB)
    const entityIds = getRelIds(props.Client)
    let entityName  = ''
    if (entityIds.length) {
      try {
        const ep = await getPage(entityIds[0], NOTION_KEY())
        entityName = getTitleStr(ep.properties || {}) || ''
      } catch (e) {
        console.warn('[submit-qc] entity fetch failed:', e.message)
      }
    }

    const relField = isQuote ? 'Linked Quotation' : 'Linked Proposal'
    const qcRound  = await getQcRound(page_id, relField)
    const qcName   = `QC — ${refNo}${qcRound > 1 ? ` (Round ${qcRound})` : ''}`
    const now      = new Date().toISOString()

    console.log('[submit-qc] creating QC record:', qcName, '| type:', type, '| status:', status, '| entity:', entityName)

    // ── Create QC record ────────────────────────────────────────────────────
    const qcProps = {
      Name:            { title: [{ text: { content: qcName } }] },
      Type:            { select: { name: isQuote ? 'Quotation' : 'Proposal' } },
      'Review Status': { select: { name: 'Pending Review' } },
      [relField]:      { relation: [{ id: page_id }] },
      'Submitted At':  { date:   { start: now } },
      'QC Round':      { number: qcRound },
      Amount:          { number: amount },
      Currency:        { select: { name: currency } },
      'Entity Name':   { rich_text: [{ text: { content: entityName } }] },
    }
    if (quoteType) qcProps['Quote Type'] = { select: { name: quoteType } }

    const qcPage = await createPage({ parent: { database_id: QC_DB }, properties: qcProps }, NOTION_KEY())
    console.log('[submit-qc] QC record created:', qcPage.id)

    // ── Set Review Status on source page (non-fatal) ─────────────────────────
    try {
      await patchPage(page_id, { 'Review Status': { select: { name: 'Pending Review' } } }, NOTION_KEY())
    } catch (e) {
      console.warn('[submit-qc] source page patch failed (non-fatal):', e.message)
    }

    // ── Comment on source page (non-fatal) ───────────────────────────────────
    try {
      await fetch('https://api.notion.com/v1/comments', {
        method:  'POST',
        headers: hdrs(),
        body:    JSON.stringify({
          parent:    { page_id },
          rich_text: [{ text: { content: `Submitted for QC review (Round ${qcRound}) — ${new Date().toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur' })} MYT` } }],
        }),
      })
    } catch (_) { /* non-fatal */ }

    return res.status(200).json({
      ok:         true,
      qcRef:      qcName,
      qcId:       qcPage.id,
      round:      qcRound,
      type,
      refNo,
      entityName,
    })

  } catch (err) {
    console.error('[submit-qc] error:', err)
    return res.status(500).json({ error: err.message || 'Internal error' })
  }
}
