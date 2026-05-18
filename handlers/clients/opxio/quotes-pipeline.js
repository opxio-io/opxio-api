import { getClientByToken, getNotionToken } from '../../../lib/supabase.js'
import { cacheGet, cacheSet, cacheKey } from '../../../lib/cache.js'

const QUOTES_DB    = 'b54fe60097f683e1930d012d635b14d5'
const PROPOSALS_DB = '1ad661f2679047749d16d2767291a30f'
const ENTITIES_DB  = 'fcdfe60097f68306b6a3876bc4f785ca'

async function queryAll(dbId, notionKey) {
  const headers = {
    'Authorization': `Bearer ${notionKey}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  }
  let results = [], hasMore = true, cursor
  while (hasMore) {
    const body = { page_size: 100 }
    if (cursor) body.start_cursor = cursor
    const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: 'POST', headers, body: JSON.stringify(body)
    })
    if (!r.ok) throw new Error(await r.text())
    const d = await r.json()
    results = results.concat(d.results)
    hasMore = d.has_more
    cursor  = d.next_cursor
  }
  return results
}

const getStatus   = p => p?.status?.name  || p?.select?.name  || null
const getNum      = p => typeof p?.number === 'number' ? p.number : null
const getDate     = p => p?.date?.start   || null
const getSelect   = p => p?.select?.name  || null
const getRelIds   = p => (p?.relation     || []).map(r => r.id)
const getTitleStr = props => {
  const tp = Object.values(props || {}).find(v => v.type === 'title')
  return (tp?.title || []).map(t => t.plain_text).join('').trim()
}

function daysDiff(dateStr, ref) {
  if (!dateStr) return null
  return Math.floor((ref - new Date(dateStr)) / 86400000)
}

// Works for both quotes (dateField='Issue Date', approvedStatus='Approved')
// and proposals (dateField='Date', approvedStatus='Accepted')
function computeStats({ items, entityMap, mStart, mEnd, now, dateField, approvedStatus }) {
  const OPEN = new Set(['Draft', 'Ready to Send', 'Sent'])
  const funnelOrder = ['Draft', 'Ready to Send', 'Sent', approvedStatus, 'Declined', 'Expired']

  let issuedMTD = 0, valueMTD = 0, approvedMTD = 0, pendingCount = 0
  let approvedAll = 0, decidedAll = 0
  const funnelC = {}, funnelV = {}, typeCounts = {}
  const activeItems = []

  for (const q of items) {
    const p          = q.properties
    const status     = getStatus(p.Status)
    const amount     = getNum(p.Amount)    || 0
    const issueDate  = getDate(p[dateField])
    const validUntil = getDate(p['Valid Until'])
    const quoteType  = getSelect(p['Quote Type'])
    const currency   = getSelect(p.Currency) || 'MYR'
    const refNo      = getTitleStr(p) || '—'
    const entityIds  = getRelIds(p.Entity)
    const entity     = entityIds.length ? (entityMap[entityIds[0]] || '—') : '—'

    if (!status) continue

    funnelC[status] = (funnelC[status] || 0) + 1
    funnelV[status] = (funnelV[status] || 0) + amount

    if (OPEN.has(status) && quoteType)
      typeCounts[quoteType] = (typeCounts[quoteType] || 0) + 1

    if (status === approvedStatus) { approvedAll++; decidedAll++ }
    if (status === 'Declined')       decidedAll++

    const issued  = issueDate ? new Date(issueDate) : null
    const inMonth = issued && issued >= mStart && issued <= mEnd
    if (inMonth) {
      issuedMTD++
      valueMTD += amount
      if (status === approvedStatus) approvedMTD++
    }

    if (OPEN.has(status)) {
      pendingCount++
      const daysOpen        = daysDiff(issueDate, now)
      const daysSent        = status === 'Sent' ? daysOpen : null
      const needsFollowUp   = status === 'Sent' && daysOpen !== null && daysOpen >= 7
      const daysUntilExpiry = validUntil ? Math.floor((new Date(validUntil) - now) / 86400000) : null
      const expiringSoon    = daysUntilExpiry !== null && daysUntilExpiry >= 0 && daysUntilExpiry <= 3
      activeItems.push({ refNo, entity, amount, currency, status, quoteType: quoteType || '—', daysOpen, daysSent, needsFollowUp, expiringSoon })
    }
  }

  const openValue  = (funnelV['Draft'] || 0) + (funnelV['Ready to Send'] || 0) + (funnelV['Sent'] || 0)
  const convRate   = decidedAll > 0 ? Math.round((approvedAll / decidedAll) * 100) : null
  const funnel     = funnelOrder.map(s => ({ status: s, count: funnelC[s] || 0, value: funnelV[s] || 0 }))

  activeItems.sort((a, b) => (b.needsFollowUp ? 1 : 0) - (a.needsFollowUp ? 1 : 0))

  return {
    kpi: { issuedMTD, valueMTD, pendingCount, approvedMTD, convRate, openValue },
    funnel,
    activeItems,
    typeBreakdown: typeCounts,
  }
}

async function fetchAndCache(ck, NOTION_KEY) {
  const [quotes, proposals, entities] = await Promise.all([
    queryAll(QUOTES_DB,    NOTION_KEY),
    queryAll(PROPOSALS_DB, NOTION_KEY),
    queryAll(ENTITIES_DB,  NOTION_KEY).catch(() => []),
  ])
  const entityMap = {}
  for (const e of entities) {
    const name = getTitleStr(e.properties)
    if (name) entityMap[e.id] = name
  }
  cacheSet(ck, { quotes, proposals, entityMap })
  return { data: { quotes, proposals, entityMap }, stale: false }
}

export async function handler(req, res) {
  try {
    const token = req.query.token || req.body?.token
    if (!token) return res.status(401).json({ error: 'Missing token' })

    const client = await getClientByToken(token)
    if (!client) return res.status(403).json({ error: 'Invalid token' })

    const NOTION_KEY = getNotionToken(client)
    const ck = cacheKey('opxio:quotes-pipeline', client.id)

    let cached = cacheGet(ck)
    if (!cached) {
      cached = await fetchAndCache(ck, NOTION_KEY)
    } else if (cached.stale) {
      fetchAndCache(ck, NOTION_KEY).catch(console.error)
    }

    const { quotes, proposals, entityMap } = cached.data

    const now    = new Date()
    const reqY   = parseInt(req.query.year)  || now.getFullYear()
    const reqM   = parseInt(req.query.month)
    const month  = isNaN(reqM) ? now.getMonth() : reqM
    const mStart = new Date(reqY, month, 1)
    const mEnd   = new Date(reqY, month + 1, 0, 23, 59, 59)

    const qStats = computeStats({ items: quotes,    entityMap, mStart, mEnd, now, dateField: 'Issue Date', approvedStatus: 'Approved' })
    const pStats = computeStats({ items: proposals, entityMap, mStart, mEnd, now, dateField: 'Date',       approvedStatus: 'Accepted' })

    res.json({
      // KPI row — quotes-focused (revenue)
      kpi: {
        ...qStats.kpi,
        proposalsSentMTD:   pStats.kpi.issuedMTD,
        proposalsAccepted:  pStats.kpi.approvedMTD,
        proposalConvRate:   pStats.kpi.convRate,
        proposalOpenValue:  pStats.kpi.openValue,
      },
      // Quotes tab
      quoteFunnel:        qStats.funnel,
      quoteActiveItems:   qStats.activeItems,
      quoteTypeBreakdown: qStats.typeBreakdown,
      quoteConvRate:      qStats.kpi.convRate,
      // Proposals tab
      proposalFunnel:        pStats.funnel,
      proposalActiveItems:   pStats.activeItems,
      proposalTypeBreakdown: pStats.typeBreakdown,
      proposalConvRate:      pStats.kpi.convRate,
    })
  } catch (err) {
    console.error('quotes-pipeline error:', err)
    res.status(500).json({ error: err.message })
  }
}
