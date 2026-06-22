// handlers/clients/pointgate/overdue.js
// GET  /api/clients/pointgate/overdue          — all past-due payments
// POST /api/clients/pointgate/overdue/send     — send WhatsApp to single record

import { queryDB, plain, hdrs } from '../../../lib/notion.js'
import { cacheGet, cacheSet, cacheKey, cacheDelete } from '../../../lib/cache.js'

const NOTION_KEY    = () => process.env.POINTGATE_NOTION_KEY || process.env.NOTION_API_KEY
const WA_TOKEN      = () => process.env.WHATSAPP_TOKEN
const WA_PHONE_ID   = () => process.env.WHATSAPP_PHONE_ID
const NOTIFY_SECRET = process.env.POINTGATE_NOTIFY_SECRET || 'pointgate-notify'

const PG = {
  PAYMENTS:   'cdc0a5b7e9384afabdc83cb24004f6f8',
  TENANTS:    '11bc170f3fc643b2b0e12ef9ef712300',
  PROPERTIES: '979e0918c8db459694657c30743c4846',
}

const TEMPLATE_14D = 'pointgate_overdue_14d'
const TEMPLATE_21D = 'pointgate_overdue_21d'
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

const CK = cacheKey('pointgate', 'overdue', 'v1')

// ── Helpers ────────────────────────────────────────────────────────────────

function tier(daysOver) {
  if (daysOver >= 60)  return 'critical'   // 60+ days
  if (daysOver >= 30)  return 'severe'     // 30–59 days
  if (daysOver >= 21)  return 'urgent'     // 21–29 days
  if (daysOver >= 14)  return 'warning'    // 14–20 days
  if (daysOver >= 7)   return 'notice'     // 7–13 days
  return 'recent'                           // 1–6 days
}

async function fetchAll(token) {
  const cached = cacheGet(CK)
  if (cached) return cached

  const [paymentPages, tenantPages, propPages] = await Promise.all([
    queryDB(PG.PAYMENTS, { property: 'Status', select: { does_not_equal: 'Paid' } }, token),
    queryDB(PG.TENANTS, undefined, token),
    queryDB(PG.PROPERTIES, undefined, token),
  ])

  // propMap: propId → lot name
  const propMap = {}
  for (const p of propPages) {
    propMap[p.id.replace(/-/g, '')] = plain(p.properties['Property Name']?.title || []) || ''
  }

  // tenantMap: tenantId → { name, phone }
  const tenantMap = {}
  for (const p of tenantPages) {
    const id = p.id.replace(/-/g, '')
    tenantMap[id] = {
      name:  plain(p.properties['Full Name']?.title || []) || '',
      phone: p.properties['Phone']?.phone_number || '',
    }
  }

  const today = new Date(); today.setHours(0,0,0,0)
  const rows = []

  for (const page of paymentPages) {
    const p = page.properties
    const dueStr = p['Due Date']?.date?.start || null
    if (!dueStr) continue

    const dueDate = new Date(dueStr + 'T00:00:00')
    const daysOver = Math.floor((today - dueDate) / 86400000)
    if (daysOver <= 0) continue

    const propRels = (p['Property']?.relation || []).map(r => r.id.replace(/-/g, ''))
    const propId   = propRels[0] || ''
    const lot      = propMap[propId] || '—'

    const tenRels  = (p['Tenant']?.relation || []).map(r => r.id.replace(/-/g, ''))
    const tenantId = tenRels[0] || ''
    const ten      = tenantMap[tenantId] || { name: '', phone: '' }

    const amtDue  = p['Amount Due (RM)']?.number ?? 0
    const amtPaid = p['Paid']?.number            ?? 0
    const bf      = p['Balance B/F (RM)']?.number ?? 0
    const balance = bf + amtDue - amtPaid

    const monthStr   = p['Payment Month']?.date?.start?.substring(0,7) || ''
    const [yr, mo]   = monthStr.split('-').map(Number)
    const monthLabel = mo ? `${MONTHS[mo-1]} ${yr}` : monthStr

    const sent14  = p['Notice 14d Sent']?.date?.start || null
    const sent21  = p['Notice 21d Sent']?.date?.start || null
    const status  = p['Status']?.select?.name || p['Status']?.status?.name || ''
    const method  = p['Payment Method']?.select?.name || ''
    const payDate = p['Payment Date']?.date?.start || null

    rows.push({
      id: page.id,
      lot, tenantId,
      tenant: ten.name,
      phone:  ten.phone,
      monthStr, monthLabel, dueDate: dueStr,
      amtDue, amtPaid, bf, balance,
      daysOver, status, method, payDate,
      sent14, sent21,
      tier: tier(daysOver),
    })
  }

  rows.sort((a, b) => b.daysOver - a.daysOver)

  const data = { rows, ts: new Date().toISOString() }
  cacheSet(CK, data)
  return data
}

// ── WhatsApp send ──────────────────────────────────────────────────────────

async function sendWA(to, templateName, params) {
  const token   = WA_TOKEN()
  const phoneId = WA_PHONE_ID()
  if (!token || !phoneId) throw new Error('WhatsApp not configured')
  const num = to.replace(/[\s\-+]/g, '')
  const body = {
    messaging_product: 'whatsapp', to: num, type: 'template',
    template: {
      name: templateName, language: { code: 'en' },
      components: [{ type: 'body', parameters: params.map(t => ({ type: 'text', text: String(t) })) }],
    },
  }
  const res = await fetch(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) { const e = await res.text(); throw new Error(`WA ${res.status}: ${e}`) }
  return res.json()
}

async function markNoticeSent(pageId, field, token) {
  const today = new Date().toISOString().substring(0,10)
  await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'PATCH', headers: hdrs(token),
    body: JSON.stringify({ properties: { [field]: { date: { start: today } } } }),
  })
}

// ── GET handler ────────────────────────────────────────────────────────────

export async function listHandler(req, res) {
  try {
    const token = NOTION_KEY()
    if (req.query._t) cacheDelete(CK)   // force refresh
    const { rows, ts } = await fetchAll(token)

    const summary = {
      critical: rows.filter(r => r.tier === 'critical').length,
      severe:   rows.filter(r => r.tier === 'severe').length,
      urgent:   rows.filter(r => r.tier === 'urgent').length,
      warning:  rows.filter(r => r.tier === 'warning').length,
      notice:   rows.filter(r => r.tier === 'notice').length,
      recent:   rows.filter(r => r.tier === 'recent').length,
      total:    rows.length,
    }

    res.json({ ok: true, rows, summary, ts })
  } catch (err) {
    console.error('[overdue] list error:', err.message)
    res.status(500).json({ error: err.message })
  }
}

// ── POST /send — single record WhatsApp ────────────────────────────────────

export async function sendHandler(req, res) {
  const secret = req.headers['x-notify-secret'] || req.query.secret
  if (secret !== NOTIFY_SECRET) return res.status(401).json({ error: 'Unauthorized' })

  const { pageId, forceTemplate } = req.body || {}
  if (!pageId) return res.status(400).json({ error: 'pageId required' })

  try {
    const token = NOTION_KEY()

    // Fetch fresh payment page
    const pageRes = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      headers: hdrs(token),
    })
    if (!pageRes.ok) throw new Error(`Notion fetch failed: ${pageRes.status}`)
    const page = await pageRes.json()
    const p    = page.properties

    const dueStr = p['Due Date']?.date?.start
    if (!dueStr) return res.status(400).json({ error: 'No due date on this record' })

    const today    = new Date(); today.setHours(0,0,0,0)
    const dueDate  = new Date(dueStr + 'T00:00:00')
    const daysOver = Math.floor((today - dueDate) / 86400000)

    // Get tenant phone
    const tenRels  = (p['Tenant']?.relation || []).map(r => r.id.replace(/-/g, ''))
    const tenantId = tenRels[0] || ''
    if (!tenantId) return res.status(400).json({ error: 'No tenant linked to this payment' })

    const tenRes = await fetch(`https://api.notion.com/v1/pages/${tenantId}`, { headers: hdrs(token) })
    const tenPage = await tenRes.json()
    const phone = tenPage.properties['Phone']?.phone_number || ''
    const name  = plain(tenPage.properties['Full Name']?.title || []) || ''

    if (!phone) return res.status(400).json({ error: 'Tenant has no phone number' })

    const amtDue  = p['Amount Due (RM)']?.number ?? 0
    const amtPaid = p['Paid']?.number ?? 0
    const bf      = p['Balance B/F (RM)']?.number ?? 0
    const balance = bf + amtDue - amtPaid
    const monthStr = p['Payment Month']?.date?.start?.substring(0,7) || dueStr.substring(0,7)
    const balFmt = `RM ${balance.toLocaleString('en-MY', { minimumFractionDigits: 2 })}`

    // Determine template: forceTemplate overrides, else pick by daysOver
    let templateName, noticeField
    if (forceTemplate === '21d' || (!forceTemplate && daysOver >= 21)) {
      templateName = TEMPLATE_21D; noticeField = 'Notice 21d Sent'
    } else {
      templateName = TEMPLATE_14D; noticeField = 'Notice 14d Sent'
    }

    await sendWA(phone, templateName, [name, monthStr, balFmt, String(daysOver)])
    await markNoticeSent(pageId, noticeField, token)

    // Bust overdue cache
    cacheDelete(CK)

    res.json({ ok: true, sent: { to: phone, name, template: templateName, daysOver } })
  } catch (err) {
    console.error('[overdue/send] error:', err.message)
    res.status(500).json({ error: err.message })
  }
}
