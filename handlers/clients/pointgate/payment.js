// handlers/clients/pointgate/payment.js
// Inline-edit a Rent Payment record from the Pointgate dashboard widget.
// PATCH /api/clients/pointgate/payment
// Body: { pageId, paid?, method?, status?, payDate? }
//
// Also invalidates the dashboard cache so the next poll gets fresh data.

import { patchPage }                    from '../../../lib/notion.js'
import { cacheDelete, cacheKey }        from '../../../lib/cache.js'

const NOTION_KEY = () => process.env.POINTGATE_NOTION_KEY || process.env.NOTION_API_KEY
const DASHBOARD_CK = cacheKey('pointgate', 'dashboard', 'v5')

const VALID_STATUSES = new Set(['Paid', 'Partial', 'Overdue', 'Pending'])
const VALID_METHODS  = new Set(['Cash', 'Bank Transfer', 'Online Banking', 'Cheque', ''])

export async function handler(req, res) {
  if (req.method !== 'PATCH' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { pageId, paid, method, status, payDate } = req.body || {}

  if (!pageId || typeof pageId !== 'string') {
    return res.status(400).json({ error: 'pageId required' })
  }

  // Build Notion properties update — only include what was sent
  const props = {}

  if (paid !== undefined && paid !== null) {
    const n = Number(paid)
    if (isNaN(n) || n < 0) return res.status(400).json({ error: 'paid must be a non-negative number' })
    props['Paid'] = { number: n }
  }

  if (status !== undefined) {
    if (!VALID_STATUSES.has(status)) return res.status(400).json({ error: `Invalid status: ${status}` })
    props['Status'] = { select: { name: status } }
  }

  if (method !== undefined) {
    if (!VALID_METHODS.has(method)) return res.status(400).json({ error: `Invalid method: ${method}` })
    props['Payment Method'] = method ? { select: { name: method } } : { select: null }
  }

  if (payDate !== undefined) {
    props['Payment Date'] = payDate ? { date: { start: payDate } } : { date: null }
  }

  if (!Object.keys(props).length) {
    return res.status(400).json({ error: 'No fields to update' })
  }

  try {
    const token = NOTION_KEY()
    // Normalise page ID (with or without dashes — patchPage expects dashes)
    const normalId = pageId.replace(/-/g, '').replace(
      /^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'
    )
    await patchPage(normalId, props, token)

    // Bust cache so widget reloads fresh data
    cacheDelete(DASHBOARD_CK)

    res.json({ ok: true, pageId: normalId, updated: Object.keys(props) })
  } catch (err) {
    console.error('[pointgate:payment] error:', err.message)
    res.status(500).json({ error: err.message })
  }
}
