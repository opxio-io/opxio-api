// handlers/clients/pointgate/properties.js
// GET /api/clients/pointgate/properties

import { queryDB, plain } from '../../../lib/notion.js'
import { cacheGet, cacheSet, cacheKey } from '../../../lib/cache.js'

const NOTION_KEY = () => process.env.POINTGATE_NOTION_KEY || process.env.NOTION_API_KEY

const PG = {
  PROPERTIES: '979e0918c8db459694657c30743c4846',
  TENANTS:    '11bc170f3fc643b2b0e12ef9ef712300',
  PAYMENTS:   'cdc0a5b7e9384afabdc83cb24004f6f8',
}

const CK = cacheKey('pointgate', 'properties', 'v2')

// ── Extractors ─────────────────────────────────────────────────────────────
const getSelect   = p => p?.select?.name || p?.status?.name || null
const getNumber   = p => p?.number ?? null
const getText     = p => (p?.rich_text || []).map(t => t.plain_text).join('') || null
const getMultiSel = p => (p?.multi_select || []).map(s => s.name)
const getRelIds   = p => (p?.relation || []).map(r => r.id.replace(/-/g, ''))

function getRollupDate(prop) {
  if (!prop || prop.type !== 'rollup') return null
  const r = prop.rollup
  if (r?.type === 'date') return r.date?.start || null
  return null
}

// ── Fetch all three DBs in parallel ────────────────────────────────────────
async function fetchAll(token) {
  const [propPages, tenantPages, payPages] = await Promise.all([
    queryDB(PG.PROPERTIES, undefined, token),
    queryDB(PG.TENANTS,    undefined, token),
    queryDB(PG.PAYMENTS,   undefined, token),
  ])

  // propId → lot name
  const propMap = {}
  for (const p of propPages) {
    propMap[p.id.replace(/-/g, '')] = plain(p.properties['Property Name']?.title || []) || ''
  }

  // tenantId → { name }
  // propId   → [{ id, name }]  (from Tenant.Property dual relation)
  const tenantMap     = {}
  const propToTenants = {}
  for (const p of tenantPages) {
    const id   = p.id.replace(/-/g, '')
    const name = plain(p.properties['Full Name']?.title || []) || ''
    tenantMap[id] = name
    for (const propId of getRelIds(p.properties['Property'])) {
      if (!propToTenants[propId]) propToTenants[propId] = []
      propToTenants[propId].push({ id, name })
    }
  }

  // lot → tenantId  (from payment records that have direct Tenant relation)
  const lotTenantMap = {}
  for (const page of payPages) {
    const pr    = page.properties
    const tenId = getRelIds(pr['Tenant'])[0]
    if (!tenId) continue
    const propId = getRelIds(pr['Property'])[0] || ''
    const lot    = propMap[propId] || ''
    if (lot && !lotTenantMap[lot]) lotTenantMap[lot] = tenId
  }

  return { propPages, propMap, tenantMap, propToTenants, lotTenantMap }
}

// ── Main handler ───────────────────────────────────────────────────────────
export async function handler(req, res) {
  try {
    const token = NOTION_KEY()

    let data = cacheGet(CK)
    if (!data || req.query._t) {
      data = await fetchAll(token)
      cacheSet(CK, data)
    }

    const { propPages, propMap, tenantMap, propToTenants, lotTenantMap } = data
    const today = new Date(); today.setHours(0,0,0,0)

    const rows = propPages.map(page => {
      const p   = page.properties
      const pid = page.id.replace(/-/g, '')
      const lot = plain(p['Property Name']?.title || []) || '—'

      const notionStatus = getSelect(p['Status'])
      const rent         = getNumber(p['Monthly Rent (RM)'])
      const deposit      = getNumber(p['Default Deposit (RM)'])
      const type         = getSelect(p['Type'])
      const furnishing   = getSelect(p['Furnishing'])
      const bedrooms     = getNumber(p['Bedrooms'])
      const bathrooms    = getNumber(p['Bathrooms'])
      const area         = getNumber(p['Floor Area (sqft)'])
      const facilities   = getMultiSel(p['Facilities'])
      const address      = getText(p['Address'])
      const unitNo       = getText(p['Unit #'])
      const remarks      = getText(p['Remarks'])
      const leaseEnd     = getRollupDate(p['Lease End'])
      const block        = lot.match(/^\d{4}/)?.[0] || ''

      // ── Three-tier tenant resolution ──────────────────────────────────
      // 1. propToTenants from Tenant.Property dual relation
      const fromDual  = propToTenants[pid]
      let tenantName  = ''
      let tenantId    = ''
      if (fromDual?.length === 1) {
        tenantId   = fromDual[0].id
        tenantName = fromDual[0].name
      } else if (fromDual?.length > 1) {
        // Multiple tenants on same property — join names
        tenantName = fromDual.map(t => t.name).join(', ')
        tenantId   = fromDual[0].id
      } else {
        // 2. lotTenantMap from payment records
        const ltId = lot !== '—' ? lotTenantMap[lot] : null
        if (ltId) {
          tenantId   = ltId
          tenantName = tenantMap[ltId] || ''
        }
      }

      // ── Derive status ─────────────────────────────────────────────────
      // If Notion has a non-Vacant status, trust it.
      // If Notion says Vacant but we resolved a tenant, mark Occupied.
      let status = notionStatus
      if ((!status || status === 'Vacant') && tenantName) {
        status = 'Occupied'
      }

      // Days until lease expiry
      let daysToExpiry = null
      if (leaseEnd) {
        const expDate = new Date(leaseEnd + 'T00:00:00')
        daysToExpiry  = Math.floor((expDate - today) / 86400000)
      }

      return {
        id: page.id,
        lot, block, status, rent, deposit,
        type, furnishing, bedrooms, bathrooms, area,
        facilities, address, unitNo, remarks,
        tenant: tenantName, leaseEnd, daysToExpiry,
      }
    })

    rows.sort((a, b) => a.lot.localeCompare(b.lot, 'en', { numeric: true }))

    // KPI
    const total        = rows.length
    const occupied     = rows.filter(r => r.status === 'Occupied').length
    const vacant       = rows.filter(r => !r.status || r.status === 'Vacant').length
    const maintenance  = rows.filter(r => r.status === 'Under Maintenance').length
    const revenue      = rows.filter(r => r.status === 'Occupied').reduce((s,r) => s+(r.rent||0), 0)
    const expiringIn30 = rows.filter(r => r.daysToExpiry !== null && r.daysToExpiry >= 0 && r.daysToExpiry <= 30).length
    const expiringIn60 = rows.filter(r => r.daysToExpiry !== null && r.daysToExpiry >  30 && r.daysToExpiry <= 60).length
    const blocks       = [...new Set(rows.map(r => r.block).filter(Boolean))].sort()

    res.json({
      ok: true, rows,
      kpi: { total, occupied, vacant, maintenance, revenue, expiringIn30, expiringIn60 },
      blocks,
      ts: new Date().toISOString(),
    })
  } catch (err) {
    console.error('[properties] error:', err.message)
    res.status(500).json({ error: err.message })
  }
}
