// handlers/clients/pointgate/dashboard.js
// Rent payment dashboard data for Pointgate HQ widget
// GET /api/clients/pointgate/dashboard?month=2026-06&block=3416&status=Paid
//
// Cache strategy: raw Notion pages cached 5 min (stale-while-revalidate 30 min)
// Filtering happens in-memory after cache hit — filter changes are instant.

import { queryDB, plain }               from '../../../lib/notion.js'
import { cacheGet, cacheSet, cacheKey } from '../../../lib/cache.js'

const NOTION_KEY = () => process.env.POINTGATE_NOTION_KEY || process.env.NOTION_API_KEY

const PG = {
  PAYMENTS:   'cdc0a5b7e9384afabdc83cb24004f6f8',
  PROPERTIES: '979e0918c8db459694657c30743c4846',
  TENANTS:    '11bc170f3fc643b2b0e12ef9ef712300',
}

const CK = cacheKey('pointgate', 'dashboard', 'v1')

// ── Notion fetchers ────────────────────────────────────────────────────────

async function fetchPayments(token) {
  return queryDB(PG.PAYMENTS, {
    property: 'Payment Month',
    date: { on_or_after: '2026-01-01' },
  }, token)
}

async function fetchPropMap(token) {
  const pages = await queryDB(PG.PROPERTIES, undefined, token)
  const map = {}
  for (const p of pages) {
    const id = p.id.replace(/-/g, '')
    map[id] = plain(p.properties['Property Name']?.title || []) || id
  }
  return map
}

async function fetchTenantMap(token) {
  const pages = await queryDB(PG.TENANTS, undefined, token)
  const map = {}
  for (const p of pages) {
    const id = p.id.replace(/-/g, '')
    map[id] = plain(p.properties['Full Name']?.title || []) || ''
  }
  return map
}

async function fetchAll(token) {
  const [payments, propMap, tenantMap] = await Promise.all([
    fetchPayments(token),
    fetchPropMap(token),
    fetchTenantMap(token),
  ])
  return { payments, propMap, tenantMap }
}

// ── Main handler ───────────────────────────────────────────────────────────

export async function handler(req, res) {
  const t0 = Date.now()
  try {
    const token = NOTION_KEY()

    // Cache check (stale-while-revalidate)
    let result = cacheGet(CK)
    if (!result) {
      const fresh = await fetchAll(token)
      cacheSet(CK, fresh)
      result = { data: fresh, stale: false }
    } else if (result.stale) {
      fetchAll(token).then(fresh => cacheSet(CK, fresh)).catch(e =>
        console.warn('[pointgate:dashboard] bg refresh failed:', e.message)
      )
    }

    const { payments, propMap, tenantMap } = result.data

    // Parse query filters
    const filterMonth  = req.query.month  || null   // e.g. "2026-06"
    const filterBlock  = req.query.block  || null   // e.g. "3416"
    const filterStatus = req.query.status || null   // e.g. "Paid"

    // Build rows from raw Notion pages
    const rows = []
    for (const page of payments) {
      const p = page.properties

      // Property (lot)
      const propRels  = (p['Property']?.relation || []).map(r => r.id.replace(/-/g, ''))
      const propId    = propRels[0] || ''
      const lot       = propMap[propId] || propId || '—'
      const block     = lot.match(/^\d{4}/)?.[0] || ''

      // Tenant
      const tenRels   = (p['Tenant']?.relation || []).map(r => r.id.replace(/-/g, ''))
      const tenantId  = tenRels[0] || ''
      const tenant    = tenantMap[tenantId] || ''

      // Fields
      const month     = p['Payment Month']?.date?.start?.substring(0, 7) || ''
      const status    = p['Status']?.select?.name     || 'Pending'
      const amtDue    = p['Amount Due (RM)']?.number  ?? 0
      const amtPaid   = p['Paid']?.number             ?? 0
      const method    = p['Payment Method']?.select?.name || ''
      const payDate   = p['Payment Date']?.date?.start || null
      const dueDate   = p['Due Date']?.date?.start    || null

      // Apply filters
      if (filterMonth  && month  !== filterMonth)  continue
      if (filterBlock  && block  !== filterBlock)  continue
      if (filterStatus && status !== filterStatus) continue

      rows.push({
        id:      page.id,
        lot,
        block,
        tenant,
        month,
        amtDue,
        amtPaid,
        balance: amtDue - amtPaid,
        status,
        method,
        payDate,
        dueDate,
      })
    }

    // Sort by lot code (alphanumeric), then month
    rows.sort((a, b) =>
      a.lot.localeCompare(b.lot, 'en', { numeric: true }) ||
      a.month.localeCompare(b.month)
    )

    // Compute KPIs
    const total        = rows.length
    const paidCount    = rows.filter(r => r.status === 'Paid').length
    const partialCount = rows.filter(r => r.status === 'Partial').length
    const overdueCount = rows.filter(r => r.status === 'Overdue').length
    const totalDue     = rows.reduce((s, r) => s + r.amtDue,  0)
    const totalPaid    = rows.reduce((s, r) => s + r.amtPaid, 0)
    const outstanding  = totalDue - totalPaid
    const rate         = totalDue > 0 ? (totalPaid / totalDue) * 100 : 0

    // Unique blocks in data
    const blocks = [...new Set(
      payments
        .map(p => (p.properties['Property']?.relation?.[0]?.id.replace(/-/g, '') || ''))
        .map(id => (propMap[id] || '').match(/^\d{4}/)?.[0] || '')
        .filter(Boolean)
    )].sort()

    res.set('X-Cache', result.stale ? 'STALE' : 'HIT')
    res.json({
      kpi: { total, paidCount, partialCount, overdueCount, totalDue, totalPaid, outstanding, rate },
      rows,
      blocks,
      ts:      new Date().toISOString(),
      latency: Date.now() - t0,
    })
  } catch (err) {
    console.error('[pointgate:dashboard] error:', err.message, err.stack)
    res.status(500).json({ error: err.message })
  }
}
