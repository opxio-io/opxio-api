// handlers/clients/pointgate/dashboard.js
// Rent payment dashboard data for Pointgate HQ widget
// GET /api/clients/pointgate/dashboard?month=2026-06&block=3416&status=Paid
//
// Cache strategy: raw Notion pages cached 5 min (stale-while-revalidate 30 min)
// Filtering happens in-memory after cache hit — filter changes are instant.
// Tenant resolution: if payment record has no Tenant relation (historical data),
// falls back to Leases DB lookup by property + month overlap.

import { queryDB, plain }               from '../../../lib/notion.js'
import { cacheGet, cacheSet, cacheKey } from '../../../lib/cache.js'

const NOTION_KEY = () => process.env.POINTGATE_NOTION_KEY || process.env.NOTION_API_KEY

const PG = {
  PAYMENTS:   'cdc0a5b7e9384afabdc83cb24004f6f8',
  PROPERTIES: '979e0918c8db459694657c30743c4846',
  TENANTS:    '11bc170f3fc643b2b0e12ef9ef712300',
  LEASES:     'e01bc0b0-44b2-4870-a415-8820fe819a07'.replace(/-/g, ''),
}

const CK = cacheKey('pointgate', 'dashboard', 'v2')

// ── Notion fetchers ────────────────────────────────────────────────────────

async function fetchPayments(token) {
  return queryDB(PG.PAYMENTS, undefined, token)
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
    map[id] = {
      name: plain(p.properties['Full Name']?.title || []) || '',
      bf:   p.properties['Balance B/F (RM)']?.number ?? 0,
    }
  }
  return map
}

// Build map: propertyId → [{tenantId, start, end}] sorted by start desc
// Used to resolve tenant for historical payments with no Tenant relation
async function fetchLeaseMap(token) {
  try {
  const pages = await queryDB(PG.LEASES, undefined, token)
  const map = {}
  for (const p of pages) {
    const propRels = (p.properties['Property']?.relation || []).map(r => r.id.replace(/-/g, ''))
    const tenRels  = (p.properties['Primary Tenant']?.relation || []).map(r => r.id.replace(/-/g, ''))
    const start    = p.properties['Start Date']?.date?.start || null
    const end      = p.properties['End Date']?.date?.start   || null
    if (!propRels[0] || !tenRels[0]) continue
    const propId = propRels[0]
    if (!map[propId]) map[propId] = []
    map[propId].push({ tenantId: tenRels[0], start, end })
  }
  // Sort each property's leases by start date desc (most recent first)
  for (const id of Object.keys(map)) {
    map[id].sort((a, b) => (b.start || '').localeCompare(a.start || ''))
  }
  return map
  } catch (e) {
    console.warn('[pointgate:dashboard] fetchLeaseMap failed (DB not shared with integration?):', e.message)
    return {}
  }
}

// Return tenantId for the lease active during a given YYYY-MM month
function resolveTenantFromLeases(leaseMap, propId, month) {
  const leases = leaseMap[propId]
  if (!leases) return null
  const mStart = month + '-01'
  const mEnd   = month + '-31'
  for (const l of leases) {
    const leaseStart = l.start || '0000-01-01'
    const leaseEnd   = l.end   || '9999-12-31'
    // Lease overlaps with payment month if lease started <= month end AND lease ended >= month start
    if (leaseStart <= mEnd && leaseEnd >= mStart) return l.tenantId
  }
  return null
}

async function fetchAll(token) {
  const [payments, propMap, tenantMap, leaseMap] = await Promise.all([
    fetchPayments(token),
    fetchPropMap(token),
    fetchTenantMap(token),
    fetchLeaseMap(token),
  ])
  return { payments, propMap, tenantMap, leaseMap }
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

    const { payments, propMap, tenantMap, leaseMap } = result.data

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

      // Fields (needed for fallback lookup)
      const month     = p['Payment Month']?.date?.start?.substring(0, 7) || ''

      // Tenant — prefer direct relation on payment record, fall back to lease lookup
      const tenRels   = (p['Tenant']?.relation || []).map(r => r.id.replace(/-/g, ''))
      let tenantId    = tenRels[0] || ''
      if (!tenantId && propId && month) {
        tenantId = resolveTenantFromLeases(leaseMap, propId, month) || ''
      }
      const tenData   = tenantMap[tenantId] || { name: '', bf: 0 }

      const status    = p['Status']?.select?.name     || 'Pending'
      const amtDue    = p['Amount Due (RM)']?.number  ?? 0
      const amtPaid   = p['Paid']?.number             ?? 0
      const method    = p['Payment Method']?.select?.name || ''
      const payDate   = p['Payment Date']?.date?.start || null
      const dueDate   = p['Due Date']?.date?.start    || null
      const receiptUrl = p['Receipt URL']?.url        || null

      // Apply filters
      if (filterMonth  && month  !== filterMonth)  continue
      if (filterBlock  && block  !== filterBlock)  continue
      if (filterStatus && status !== filterStatus) continue

      rows.push({
        id:      page.id,
        lot,
        block,
        tenant:  tenData.name,
        bf:      tenData.bf,
        month,
        amtDue,
        amtPaid,
        balance: amtDue - amtPaid,
        status,
        method,
        payDate,
        dueDate,
        receiptUrl,
      })
    }

    // Dedup: keep one row per lot+month (first seen = most recent Notion page)
    const seen = new Map()
    for (const row of rows) {
      const key = `${row.lot}__${row.month}`
      if (!seen.has(key)) seen.set(key, row)
    }
    const deduped = [...seen.values()]

    // Sort by lot code (alphanumeric), then month
    deduped.sort((a, b) =>
      a.lot.localeCompare(b.lot, 'en', { numeric: true }) ||
      a.month.localeCompare(b.month)
    )

    const rows_final = deduped

    // Compute KPIs
    const total        = rows_final.length
    const paidCount    = rows_final.filter(r => r.status === 'Paid').length
    const partialCount = rows_final.filter(r => r.status === 'Partial').length
    const overdueCount = rows_final.filter(r => r.status === 'Overdue').length
    const totalDue     = rows_final.reduce((s, r) => s + r.amtDue,  0)
    const totalPaid    = rows_final.reduce((s, r) => s + r.amtPaid, 0)
    const outstanding  = totalDue - totalPaid
    const rate         = totalDue > 0 ? (totalPaid / totalDue) * 100 : 0

    // Unique blocks in full dataset (for filter pills)
    const blocks = [...new Set(
      payments
        .map(p => (p.properties['Property']?.relation?.[0]?.id.replace(/-/g, '') || ''))
        .map(id => (propMap[id] || '').match(/^\d{4}/)?.[0] || '')
        .filter(Boolean)
    )].sort()

    res.set('X-Cache', result.stale ? 'STALE' : 'HIT')
    res.json({
      kpi: { total, paidCount, partialCount, overdueCount, totalDue, totalPaid, outstanding, rate },
      rows: rows_final,
      blocks,
      ts:      new Date().toISOString(),
      latency: Date.now() - t0,
    })
  } catch (err) {
    console.error('[pointgate:dashboard] error:', err.message, err.stack)
    res.status(500).json({ error: err.message })
  }
}
