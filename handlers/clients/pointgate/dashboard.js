// handlers/clients/pointgate/dashboard.js
// Tenant resolution for historical records:
//   1. Direct Tenant relation on payment page (2026 records — linked)
//   2. lotTenantMap: built from ALL payments that have a Tenant relation, keyed by lot
//   3. propToTenants: Tenant.Property DUAL relation (single-tenant properties)

import { queryDB, plain }               from '../../../lib/notion.js'
import { cacheGet, cacheSet, cacheKey } from '../../../lib/cache.js'

const NOTION_KEY = () => process.env.POINTGATE_NOTION_KEY || process.env.NOTION_API_KEY

const PG = {
  PAYMENTS:   'cdc0a5b7e9384afabdc83cb24004f6f8',
  PROPERTIES: '979e0918c8db459694657c30743c4846',
  TENANTS:    '11bc170f3fc643b2b0e12ef9ef712300',
}

const CK = cacheKey('pointgate', 'dashboard', 'v5')

// ── Fetchers ───────────────────────────────────────────────────────────────

async function fetchPayments(token) {
  return queryDB(PG.PAYMENTS, undefined, token)
}

async function fetchPropMap(token) {
  const pages = await queryDB(PG.PROPERTIES, undefined, token)
  const map = {}
  for (const p of pages) {
    const id  = p.id.replace(/-/g, '')
    map[id] = plain(p.properties['Property Name']?.title || []) || id
  }
  return map
}

// tenantMap: tenantId → { name, bf }
// propToTenants: propId → [tenantId] (from DUAL relation, populated for some tenants)
async function fetchTenantData(token) {
  const pages = await queryDB(PG.TENANTS, undefined, token)
  const tenantMap     = {}
  const propToTenants = {}
  for (const p of pages) {
    const id   = p.id.replace(/-/g, '')
    const name = plain(p.properties['Full Name']?.title || []) || ''
    const bf   = p.properties['Balance B/F (RM)']?.number ?? 0
    tenantMap[id] = { name, bf }
    const propRels = (p.properties['Property']?.relation || []).map(r => r.id.replace(/-/g, ''))
    for (const propId of propRels) {
      if (!propToTenants[propId]) propToTenants[propId] = []
      propToTenants[propId].push(id)
    }
  }
  return { tenantMap, propToTenants }
}

async function fetchAll(token) {
  const [payments, propMap, { tenantMap, propToTenants }] = await Promise.all([
    fetchPayments(token),
    fetchPropMap(token),
    fetchTenantData(token),
  ])

  // Build lotTenantMap from ALL payments that have a Tenant relation
  // This lets us resolve historical months using the known current tenant per lot
  const lotTenantMap = {}
  for (const page of payments) {
    const p       = page.properties
    const tenRels = (p['Tenant']?.relation || []).map(r => r.id.replace(/-/g, ''))
    if (!tenRels[0]) continue
    const propRels = (p['Property']?.relation || []).map(r => r.id.replace(/-/g, ''))
    const propId   = propRels[0] || ''
    const lot      = propMap[propId] || ''
    if (lot && lot !== '—' && !lotTenantMap[lot]) {
      lotTenantMap[lot] = tenRels[0]
    }
  }

  return { payments, propMap, tenantMap, propToTenants, lotTenantMap }
}

// ── Main handler ───────────────────────────────────────────────────────────

export async function handler(req, res) {
  const t0 = Date.now()
  try {
    const token = NOTION_KEY()

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

    const { payments, propMap, tenantMap, propToTenants, lotTenantMap } = result.data

    const filterMonth  = req.query.month  || null
    const filterBlock  = req.query.block  || null
    const filterStatus = req.query.status || null

    const rows = []
    for (const page of payments) {
      const p = page.properties

      const propRels = (p['Property']?.relation || []).map(r => r.id.replace(/-/g, ''))
      const propId   = propRels[0] || ''
      const lot      = propMap[propId] || propId || '—'
      const block    = lot.match(/^\d{4}/)?.[0] || ''
      const month    = p['Payment Month']?.date?.start?.substring(0, 7) || ''

      // Tenant resolution (three tiers):
      const tenRels = (p['Tenant']?.relation || []).map(r => r.id.replace(/-/g, ''))
      let tenantId  = tenRels[0]                                           // 1. direct relation
        || (propId && propToTenants[propId]?.length === 1
              ? propToTenants[propId][0] : null)                           // 2. DUAL single-tenant
        || (lot !== '—' ? lotTenantMap[lot] : null)                       // 3. lot→tenant from any linked payment
        || ''
      const tenData = tenantMap[tenantId] || { name: '', bf: 0 }

      const status     = p['Status']?.select?.name          || 'Pending'
      const amtDue     = p['Amount Due (RM)']?.number       ?? 0
      const amtPaid    = p['Paid']?.number                  ?? 0
      const method     = p['Payment Method']?.select?.name  || ''
      const payDate    = p['Payment Date']?.date?.start     || null
      const dueDate    = p['Due Date']?.date?.start         || null
      const receiptUrl = p['Receipt URL']?.url              || null

      if (filterMonth  && month  !== filterMonth)  continue
      if (filterBlock  && block  !== filterBlock)  continue
      if (filterStatus && status !== filterStatus) continue

      rows.push({
        id: page.id, lot, block,
        tenant: tenData.name, bf: tenData.bf,
        month, amtDue, amtPaid,
        balance: amtDue - amtPaid,
        status, method, payDate, dueDate, receiptUrl,
      })
    }

    // Dedup: keep first per lot+month
    const seen = new Map()
    for (const row of rows) {
      const key = `${row.lot}__${row.month}`
      if (!seen.has(key)) seen.set(key, row)
    }
    const rows_final = [...seen.values()].sort((a, b) =>
      a.lot.localeCompare(b.lot, 'en', { numeric: true }) ||
      a.month.localeCompare(b.month)
    )

    const total        = rows_final.length
    const paidCount    = rows_final.filter(r => r.status === 'Paid').length
    const partialCount = rows_final.filter(r => r.status === 'Partial').length
    const overdueCount = rows_final.filter(r => r.status === 'Overdue').length
    const totalDue     = rows_final.reduce((s, r) => s + r.amtDue,  0)
    const totalPaid    = rows_final.reduce((s, r) => s + r.amtPaid, 0)
    const outstanding  = totalDue - totalPaid
    const rate         = totalDue > 0 ? (totalPaid / totalDue) * 100 : 0

    const blocks = [...new Set(
      payments
        .map(p => (p.properties['Property']?.relation?.[0]?.id.replace(/-/g, '') || ''))
        .map(id => (propMap[id] || '').match(/^\d{4}/)?.[0] || '')
        .filter(Boolean)
    )].sort()

    res.set('X-Cache', result.stale ? 'STALE' : 'HIT')
    res.json({
      kpi: { total, paidCount, partialCount, overdueCount, totalDue, totalPaid, outstanding, rate },
      rows: rows_final, blocks,
      ts: new Date().toISOString(), latency: Date.now() - t0,
    })
  } catch (err) {
    console.error('[pointgate:dashboard] error:', err.message, err.stack)
    res.status(500).json({ error: err.message })
  }
}
