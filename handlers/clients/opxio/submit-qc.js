// ─── submit-qc.js ─────────────────────────────────────────────────────────
// POST /api/opxio/submit-qc   { "page_id": "<quote_or_proposal_page_id>" }
// Triggered by Notion button on Quotations or Proposals DB.
//
// 1. Reads the source page (Quotation or Proposal), detects type via parent DB
// 2. Validates current status is eligible for QC submission
// 3. Creates a QC record in the QC Approval Tracker DB
// 4. Adds a Notion comment on the source page confirming submission

import { getPage, patchPage, createPage, plain, DB } from '../../../lib/notion.js'

const QC_DB        = 'e9f3b2e857b3470d8d8bef749737d99b'
const QUOTES_DB    = DB.QUOTATIONS   // 'b54fe60097f683e1930d012d635b14d5'
const PROPOSALS_DB = DB.PROPOSALS    // '1ad661f2679047749d16d2767291a30f'

// Statuses eligible for QC submission
const ELIGIBLE_QUOTE_STATUSES    = new Set(['Draft', 'Ready to Send', 'Sent'])
const ELIGIBLE_PROPOSAL_STATUSES = new Set(['Draft', 'Sent', 'Under Review'])

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
const getDate     = p => p?.date?.start    || null
const getRelIds   = p => (p?.relation      || []).map(r => r.id)
const getTitleStr = props => {
  const tp = Object.values(props || {}).find(v => v.type === 'title')
  return (tp?.title || []).map(t => t.plain_text).join('').trim()
}

// Count existing QC rounds for this source page
async function getQcRound(sourcePageId, relField) {
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
}

export async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const { page_id } = req.body || {}
  if (!page_id) return res.status(400).json({ error: 'Missing page_id' })

  try {
    // 1. Fetch page and detect type via parent DB
    const page       = await getPage(page_id, NOTION_KEY())
    const parentDbId = (page?.parent?.database_id || '').replace(/-/g, '')

    let type
    if (parentDbId === QUOTES_DB)         type = 'quotation'
    else if (parentDbId === PROPOSALS_DB) type = 'proposal'
    else {
      // Fallback: check property names
      const props = page.properties || {}
      if (props['Issue Date'] !== undefined) type = 'quotation'
      else if (props['Date'] !== undefined)  type = 'proposal'
      else return res.status(400).json({ error: `Page is not in Quotations or Proposals DB (parent: ${parentDbId})` })
    }

    const isQuote  = type === 'quotation'
    const props    = page.properties || {}
    const status   = getStatus(props.Status)
    const amount   = getNum(props.Amount)      || 0
    const currency = getSelect(props.Currency) || 'MYR'
    const quoteType= getSelect(props['Quote Type']) || null
    const refNo    = getTitleStr(props) || page_id
    const dateField= isQuote ? 'Issue Date' : 'Date'

    // 2. Validate eligibility
    const eligible = isQuote ? ELIGIBLE_QUOTE_STATUSES : ELIGIBLE_PROPOSAL_STATUSES
    if (status && !eligible.has(status)) {
      return res.status(400).json({
        error: `Cannot submit for QC: current status is "${status}". Must be one of: ${[...eligible].join(', ')}.`,
      })
    }

    // Resolve entity name
    const entityIds = getRelIds(props.Entity || props.Company)
    let entityName  = ''
    if (entityIds.length) {
      try {
        const ep = await getPage(entityIds[0], NOTION_KEY())
        entityName = getTitleStr(ep.properties || '') || ''
      } catch (_) {}
    }

    const relField = isQuote ? 'Linked Quotation' : 'Linked Proposal'
    const qcRound  = await getQcRound(page_id, relField)
    const qcName   = `QC — ${refNo}${qcRound > 1 ? ` (Round ${qcRound})` : ''}`

    // 3. Create QC record
    const qcBody = {
      parent: { database_id: QC_DB },
      properties: {
        Name: { title: [{ text: { content: qcName } }] },
        Type: { select: { name: isQuote ? 'Quotation' : 'Proposal' } },
        'Review Status': { select: { name: 'Pending Review' } },
        [relField]: { relation: [{ id: page_id }] },
        'Submitted At': { date: { start: new Date().toISOString() } },
        'QC Round': { number: qcRound },
        Amount: { number: amount },
        Currency: { select: { name: currency } },
        'Entity Name': { rich_text: [{ text: { content: entityName } }] },
        ...(quoteType ? { 'Quote Type': { select: { name: quoteType } } } : {}),
      },
    }

    const qcPage = await createPage(qcBody, NOTION_KEY())

    // 4. Add Notion comment on source page
    try {
      await fetch('https://api.notion.com/v1/comments', {
        method: 'POST',
        headers: hdrs(),
        body: JSON.stringify({
          parent: { page_id },
          rich_text: [{
            text: {
              content: `Submitted for QC review (Round ${qcRound}) — ${new Date().toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur' })} MYT`,
            },
          }],
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
    console.error('[submit-qc]', err)
    return res.status(500).json({ error: err.message || 'Internal error' })
  }
}
