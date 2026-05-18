// ─── verify-reviewer.js ────────────────────────────────────────────────────
// POST /api/opxio/verify-reviewer?token=<widget_token>
// Body: { email }
//
// 1. Validates widget token
// 2. Lists all Notion workspace members via /v1/users
// 3. Confirms email belongs to an actual workspace member
// 4. Checks email is in the 'QC Reviewer Emails' record in Settings DB
//    (if Settings DB record is empty, any workspace member is allowed)
// 5. Issues a signed session token (8h TTL)
//
// Required env vars: NOTION_API_KEY, JWT_SECRET

import { getClientByToken, getNotionToken } from '../../../lib/supabase.js'
import { queryDB, DB }                      from '../../../lib/notion.js'
import { signSession }                      from '../../../lib/session.js'

const SETTINGS_DB = DB.SETTINGS

function hdrs(key) {
  return {
    Authorization:    `Bearer ${key}`,
    'Notion-Version': '2022-06-28',
    'Content-Type':   'application/json',
  }
}

// Fetch all workspace users (paginated), return array of email strings
async function getWorkspaceEmails(notionKey) {
  const emails = []
  let hasMore = true, cursor

  while (hasMore) {
    const url = cursor
      ? `https://api.notion.com/v1/users?page_size=100&start_cursor=${cursor}`
      : 'https://api.notion.com/v1/users?page_size=100'

    const r = await fetch(url, { headers: hdrs(notionKey) })
    if (!r.ok) throw new Error(`Failed to list workspace users: ${await r.text()}`)
    const d = await r.json()

    for (const u of d.results || []) {
      // Only 'person' type users have email — bots don't
      const email = u?.person?.email
      if (email) emails.push(email.toLowerCase())
    }
    hasMore = d.has_more
    cursor  = d.next_cursor
  }
  return emails
}

// Fetch approved reviewer emails from Settings DB
async function getApprovedEmails(notionKey) {
  const rows = await queryDB(
    SETTINGS_DB,
    { property: 'Setting', title: { equals: 'QC Reviewer Emails' } },
    notionKey,
  )
  if (!rows.length) return [] // empty = no restriction beyond workspace membership

  const val = (rows[0].properties?.['QC Reviewer Emails']?.rich_text || [])
    .map(t => t.plain_text).join('').trim()

  return val.split(/[\n,]+/).map(e => e.trim().toLowerCase()).filter(Boolean)
}

export async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const token = req.query.token || req.headers['x-widget-token']
  if (!token) return res.status(401).json({ error: 'Missing token' })

  const client = await getClientByToken(token)
  if (!client) return res.status(403).json({ error: 'Invalid token' })

  const { email } = req.body || {}
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' })
  }

  const normalised = email.trim().toLowerCase()
  const notionKey  = getNotionToken(client)

  try {
    // 1. Check email is a real workspace member
    const workspaceEmails = await getWorkspaceEmails(notionKey)
    if (!workspaceEmails.includes(normalised)) {
      return res.status(403).json({
        error: 'This email is not a member of the connected Notion workspace.',
      })
    }

    // 2. Check against approved reviewer list (if configured)
    const approved = await getApprovedEmails(notionKey)
    if (approved.length && !approved.includes(normalised)) {
      return res.status(403).json({
        error: `${email} is not listed as an approved QC reviewer. Contact your workspace admin.`,
      })
    }

    // 3. Issue session token
    const session = signSession(normalised, client.id)

    return res.status(200).json({ ok: true, session, email: normalised })

  } catch (err) {
    console.error('[verify-reviewer]', err)
    return res.status(500).json({ error: err.message || 'Verification failed' })
  }
}
