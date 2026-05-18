import { getClientByToken, getNotionToken } from '../../../lib/supabase.js'
import { cacheGet, cacheSet, cacheKey, cacheDelete } from '../../../lib/cache.js'

const QUOTES_DB   = 'b54fe60097f683e1930d012d635b14d5'
const ENTITIES_DB = 'fcdfe60097f682c09be901fe6ebb6b41'

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

const FUNNEL_ORDER  = ['Draft', 'Ready to Send', 'Sent', 'Approved', 'Declined', 'Expired']
const OPEN_STATUSES = new Set(['Draft', 'Ready to Send', 'Sent'])

function daysDiff(dateStr, ref) {
  if (!dateStr) return null
  return Math.floor((ref - new Date(dateStr)) / 86400000)
}

function computeStats({ quotes, entityMap, mStart, mEnd, now }) {
  let issuedMTD = 0, quotedValueMTD = 0, approvedMTD = 0, pendingCount = 0
  let approvedAll = 0, decidedAll = 0
  const funnelC = {}, funnelV = {}, typeCounts = {}
  const activeQuotes = []

  for (const q of quotes) {
    const p          = q.properties
    const status     = getStatus(p.Status)
    const amount     = getNum(p.Amount)    || 0
    const issueDate  = getDate(p['Issue Date'])
    const validUntil = getDate(p['Valid Until'])
    const quoteType  = getSelect(p['Quote Type'])
    const currency   = getSelect(p.Currency) || 'MYR'
    const quoteNo    = getTitleStr(p) || '—'
    const entityIds  = getRelIds(p.Entity)
    const entity     = entityIds.length ? (entityMap[entityIds[0]] || '—') : '—'

    if (!status) continue

    funnelC[status] = (funnelC[status] || 0) + 1
    funnelV[status] = (funnelV[status] || 0) + amount

    if (OPEN_STATUSES.has(status) && quoteType)
      typeCounts[quoteType] = (typeCounts[quoteType] || 0) + 1

    if (status === 'Approved') { approvedAll++; decidedAll++ }
    if (status === 'Declined') decidedAll++

    const issued  = issueDate ? new Date(issueDate) : null
    const inMonth = issued && issued >= mStart && issued <= mEnd
    if (inMonth) {
      issuedMTD++
      quotedValueMTD += amount
      if (status === 'Approved') approvedMTD++
    }

    if (status === 'Sent') pendingCount++

    if (OPEN_STATUSES.has(status)) {
      const daysSent        = status === 'Sent' ? daysDiff(issueDate, now) : null
      const daysUntilExpiry = validUntil ? -daysDiff(validUntil, now) : null
      activeQuotes.push({
        id: q.id, quoteNo, entity, amount, currency, status,
        quoteType: quoteType || '—',
        issueDate, validUntil, daysSent, daysUntilExpiry,
        needsFollowUp: status === 'Sent' && daysSent !== null && daysSent >= 7,
        expiringSoon:  daysUntilExpiry !== null && daysUntilExpiry <= 3 && daysUntilExpiry >= 0
      })
    }
  }

  activeQuotes.sort((a, b) => {
    const af = (a.needsFollowUp || a.expiringSoon) ? 0 : 1
    const bf = (b.needsFollowUp || b.expiringSoon) ? 0 : 1
    return af !== bf ? af - bf : (a.issueDate || '').localeCompare(b.issueDate || '')
  })

  const openValue = (funnelV['Draft'] || 0) + (funnelV['Ready to Send'] || 0) + (funnelV['Sent'] || 0)
  const convRate  = decidedAll > 0 ? Math.round((approvedAll / decidedAll) * 100) : null

  return {
    kpi: { issuedMTD, quotedValueMTD, pendingCount, approvedMTD, convRate, openValue },
    funnel: FUNNEL_ORDER.map(s => ({ status: s, count: funnelC[s] || 0, value: funnelV[s] || 0 })),
    activeQuotes,
    typeBreakdown: typeCounts
  }
}

async function fetchAndCache(ck, NOTION_KEY) {
  const [quotes, entities] = await Promise.all([
    queryAll(QUOTES_DB, NOTION_KEY),
    queryAll(ENTITIES_DB, NOTION_KEY).catch(() => [])
  ])
  const entityMap = {}
  for (const e of entities) {
    const name = getTitleStr(e.properties)
    if (name) entityMap[e.id] = name
  }
  cacheSet(ck, { quotes, entityMap })
  return { data: { quotes, entityMap }, stale: false }
}

export async function handler(req, res) {
  try {
    const token = req.query.token || req.headers['x-widget-token']
    if (!token) return res.status(401).json({ error: 'Missing token' })
    const client = await getClientByToken(token)
    if (!client) return res.status(403).json({ error: 'Invalid token' })

    const NOTION_KEY = getNotionToken(client)
    const now    = new Date()
    const m      = req.query.month != null ? parseInt(req.query.month) : now.getMonth()
    const y      = req.query.year  != null ? parseInt(req.query.year)  : now.getFullYear()
    const mStart = new Date(y, m, 1)
    const mEnd   = new Date(y, m + 1, 0, 23, 59, 59)

    const ck = cacheKey('opxio:quotes-pipeline', client.id)
    if (req.query.refresh === '1') cacheDelete(ck)

    let cached = cacheGet(ck)
    if (!cached) {
      cached = await fetchAndCache(ck, NOTION_KEY)
    } else if (cached.stale) {
      fetchAndCache(ck, NOTION_KEY).catch(console.error)
    }

    const { quotes, entityMap } = cached.data
    res.json(computeStats({ quotes, entityMap, mStart, mEnd, now }))
  } catch (err) {
    console.error('[quotes-pipeline]', err)
    res.status(500).json({ error: err.message })
  }
}
