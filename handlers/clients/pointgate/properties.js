// handlers/clients/pointgate/properties.js
// GET /api/clients/pointgate/properties

import { queryDB, plain } from '../../../lib/notion.js'
import { cacheGet, cacheSet, cacheKey } from '../../../lib/cache.js'

const NOTION_KEY = () => process.env.POINTGATE_NOTION_KEY || process.env.NOTION_API_KEY
const PROPERTIES_DB = '979e0918c8db459694657c30743c4846'
const CK = cacheKey('pointgate', 'properties', 'v1')

// ── Prop extractors ────────────────────────────────────────────────────────

const getSelect   = p => p?.select?.name || p?.status?.name || null
const getNumber   = p => p?.number ?? null
const getText     = p => (p?.rich_text || []).map(t => t.plain_text).join('') || null
const getMultiSel = p => (p?.multi_select || []).map(s => s.name)

function getRollupNames(prop) {
  if (!prop || prop.type !== 'rollup') return []
  const r = prop.rollup
  if (r?.type === 'array') {
    return r.array.map(item => {
      if (item.type === 'title')      return (item.title     || []).map(t => t.plain_text).join('')
      if (item.type === 'rich_text')  return (item.rich_text || []).map(t => t.plain_text).join('')
      return ''
    }).filter(Boolean)
  }
  return []
}

function getRollupDate(prop) {
  if (!prop || prop.type !== 'rollup') return null
  const r = prop.rollup
  if (r?.type === 'date') return r.date?.start || null
  return null
}

// ── Main handler ───────────────────────────────────────────────────────────

export async function handler(req, res) {
  try {
    const token = NOTION_KEY()

    // Cache or fetch
    let pages = cacheGet(CK)
    if (!pages || req.query._t) {
      pages = await queryDB(PROPERTIES_DB, undefined, token)
      cacheSet(CK, pages)
    }

    const today = new Date(); today.setHours(0,0,0,0)
    const in30  = new Date(today); in30.setDate(in30.getDate()+30)
    const in60  = new Date(today); in60.setDate(in60.getDate()+60)

    const rows = pages.map(page => {
      const p   = page.properties
      const lot = plain(p['Property Name']?.title || []) || '—'

      const status      = getSelect(p['Status'])
      const rent        = getNumber(p['Monthly Rent (RM)'])
      const deposit     = getNumber(p['Default Deposit (RM)'])
      const type        = getSelect(p['Type'])
      const furnishing  = getSelect(p['Furnishing'])
      const bedrooms    = getNumber(p['Bedrooms'])
      const bathrooms   = getNumber(p['Bathrooms'])
      const area        = getNumber(p['Floor Area (sqft)'])
      const facilities  = getMultiSel(p['Facilities'])
      const address     = getText(p['Address'])
      const unitNo      = getText(p['Unit #'])
      const remarks     = getText(p['Remarks'])

      const tenants     = getRollupNames(p['Current Tenant'])
      const tenant      = tenants[0] || ''
      const leaseEnd    = getRollupDate(p['Lease End'])

      // Days until lease expiry
      let daysToExpiry = null
      if (leaseEnd) {
        const expDate = new Date(leaseEnd + 'T00:00:00')
        daysToExpiry  = Math.floor((expDate - today) / 86400000)
      }

      const block = lot.match(/^\d{4}/)?.[0] || ''

      return {
        id: page.id,
        lot, block, status, rent, deposit,
        type, furnishing, bedrooms, bathrooms, area,
        facilities, address, unitNo, remarks,
        tenant, leaseEnd, daysToExpiry,
      }
    })

    rows.sort((a, b) => a.lot.localeCompare(b.lot, 'en', { numeric: true }))

    // KPI summary
    const total       = rows.length
    const occupied    = rows.filter(r => r.status === 'Occupied').length
    const vacant      = rows.filter(r => r.status === 'Vacant').length
    const maintenance = rows.filter(r => r.status === 'Under Maintenance').length
    const revenue     = rows.filter(r => r.status === 'Occupied').reduce((s,r) => s + (r.rent||0), 0)
    const expiringIn30 = rows.filter(r => r.daysToExpiry !== null && r.daysToExpiry >= 0 && r.daysToExpiry <= 30).length
    const expiringIn60 = rows.filter(r => r.daysToExpiry !== null && r.daysToExpiry > 30 && r.daysToExpiry <= 60).length
    const blocks      = [...new Set(rows.map(r => r.block).filter(Boolean))].sort()

    res.json({
      ok: true,
      rows,
      kpi: { total, occupied, vacant, maintenance, revenue, expiringIn30, expiringIn60 },
      blocks,
      ts: new Date().toISOString(),
    })
  } catch (err) {
    console.error('[properties] error:', err.message)
    res.status(500).json({ error: err.message })
  }
}
