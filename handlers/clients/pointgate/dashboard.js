// handlers/clients/pointgate/dashboard.js
// Tenant resolution for historical records:
//   1. Direct Tenant relation on payment page (2026 records)
//   2. Lease lookup: parse lot from Agreement Title, match tenant by "Additional Tenants" text → nameToTenantId
//   3. propToTenants fallback (single-tenant properties via Tenant.Property relation)

import { queryDB, plain }               from '../../../lib/notion.js'
import { cacheGet, cacheSet, cacheKey } from '../../../lib/cache.js'

const NOTION_KEY = () => process.env.POINTGATE_NOTION_KEY || process.env.NOTION_API_KEY

const PG = {
  PAYMENTS:   'cdc0a5b7e9384afabdc83cb24004f6f8',
  PROPERTIES: '979e0918c8db459694657c30743c4846',
  TENANTS:    '11bc170f3fc643b2b0e12ef9ef712300',
  LEASES:     'e01bc0b044b24870a4158820fe819a07',
}

const CK = cacheKey('pointgate', 'dashboard', 'v4')

// ── Notion fetchers ────────────────────────────────────────────────────────

async function fetchPayments(token) {
  return queryDB(PG.PAYMENTS, undefined, token)
}

// Returns:
//   propMap:       propId   → lot name (e.g. "3420-B")
//   reversePropMap: lot name → propId  (for lease title matching)
async function fetchPropMaps(token) {
  const pages = await queryDB(PG.PROPERTIES, undefined, token)
  const propMap = {}
  const reversePropMap = {}
  for (const p of pages) {
    const id  = p.id.replace(/-/g, '')
    const lot = plain(p.properties['Property Name']?.title || []) || id
    propMap[id]          = lot
    reversePropMap[lot.toLowerCase()] = id
  }
  return { propMap, reversePropMap }
}

// Returns:
//   tenantMap:      tenantId → { name, bf }
//   nameToTenantId: lowercase name → tenantId  (for lease "Additional Tenants" matching)
//   propToTenants:  propId → [tenantId, ...]    (DUAL relation fallback)
async function fetchTenantData(token) {
  const pages = await queryDB(PG.TENANTS, undefined, token)
  const tenantMap      = {}
  const nameToTenantId = {}
  const propToTenants  = {}
  for (const p of pages) {
    const id   = p.id.replace(/-/g, '')
    const name = plain(p.properties['Full Name']?.title || []) || ''
    const bf   = p.properties['Balance B/F (RM)']?.number ?? 0
    tenantMap[id] = { name, bf }
    if (name) nameToTenantId[name.toLowerCase()] = id

    // Property relation (DUAL) — populated for some tenants
    const propRels = (p.properties['Property']?.relation || []).map(r => r.id.replace(/-/g, ''))
    for (const propId of propRels) {
      if (!propToTenants[propId]) propToTenants[propId] = []
      propToTenants[propId].push(id)
    }
  }
  return { tenantMap, nameToTenantId, propToTenants }
}

// Build leaseMap: propId → [{tenantId, start, end}]
// Resolves property via lot code parsed from Agreement Title
// Resolves tenant via "Additional Tenants" text field matched against nameToTenantId
// Graceful: returns {} if DB not accessible
async function fetchLeaseMap(token, reversePropMap, nameToTenantId) {
  try {
    const pages = await queryDB(PG.LEASES, undefined, token)
    const map = {}
    for (const p of pages) {
      const title   = plain(p.properties['Agreement Title']?.title || [])
      const tenName = p.properties['Additional Tenants']?.rich_text?.map(t => t.plain_text).join('').trim() || ''

      // Parse lot from title: "Lease #156 – 3420-B" → "3420-B"
      const lotMatch = title.match(/[–—-]\s*(.+)$/)
      const lot      = lotMatch ? lotMatch[1].trim() : ''
      const propId   = reversePropMap[lot.toLowerCase()] || ''

      // Match tenant by name (also try relation field)
      const tenRels   = (p.properties['Primary Tenant']?.relation || []).map(r => r.id.replace(/-/g, ''))
      const tenantId  = tenRels[0] || nameToTenantId[tenName.toLowerCase()] || ''

      if (!propId || !tenantId) continue

      const start = p.properties['Start Date']?.date?.start || null
      const end   = p.properties['End Date']?.date?.start   || null
      if (!map[propId]) map[propId] = []
      map[propId].push({ tenantId, start, end })
    }
    // Sort by start desc so most recent lease is checked first
    for (const id of Object.keys(map)) {
      map[id].sort((a, b) => (b.start || '').localeCompare(a.start || ''))
    }
    console.log(`[pointgate:dashboard] leaseMap: ${Object.keys(map).length} properties resolved`)
    return map
  } catch (e) {
    console.warn('[pointgate:dashboard] leaseMap unavailable:', e.message)
    return {}
  }
}

function resolveTenantFromLeases(leaseMap, propId, month) {
  const leases = leaseMap[propId]
  if (!leases) return null
  // If dates exist, use them; otherwise just return first (most recent by sort)
  const mStart = month + '-01'
  const mEnd   = month + '-31'
  for (const l of leases) {
    const s = l.start || '0000-01-01'
    const e = l.end   || '9999-12-31'
    if (s <= mEnd && e >= mStart) return l.tenantId
  }
  // Fallback: return most recent if no date match (e.g. import dates are wrong)
  return leases[0]?.tenantId || null
}

function resolveTenantFromPropMap(propToTenants, propId) {
  const tenants = propToTenants[propId]
  if (!tenants || tenants.length !== 1) return null
  return tenants[0]
}

async function fetchAll(token) {
  const [payments, { propMap, reversePropMap }, { tenantMap, nameToTenantId, propToTenants }] = await Promise.all([
    fetchPayments(token),
    fetchPropMaps(token),
    fetchTenantData(token),
  ])
  // leaseMap needs reversePropMap + nameToTenantId, fetch after
  const leaseMap = await fetchLeaseMap(token, reversePropMap, nameToTenantId)
  return { payments, propMap, tenantMap, propToTenants, leaseMap }
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

    const { payments, propMap, tenantMap, propToTenants, leaseMap } = result.data

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

      // Tenant resolution: direct → lease title match → single-tenant property fallback
      const tenRels = (p['Tenant']?.relation || []).map(r => r.id.replace(/-/g, ''))
      let tenantId  = tenRels[0] || ''
      if (!tenantId && propId && month) {
        tenantId =
          resolveTenantFromLeases(leaseMap, propId, month) ||
          resolveTenantFromPropMap(propToTenants, propId) ||
          ''
      }
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
