// ─── oauth-callback.js ─────────────────────────────────────────────────────
// GET /api/opxio/oauth/callback?code=<code>&state=<state>
//
// 1. Parses state → extracts widget token → validates client
// 2. Exchanges Notion OAuth code for a user access token
// 3. Calls /v1/users/me to get the user's email
// 4. Reads QC Reviewer Emails from the client's Settings DB
// 5. If email is approved → issues a signed session token
// 6. Redirects to the QC review widget with ?session=<token>
//
// Required env vars:
//   NOTION_OAUTH_CLIENT_ID
//   NOTION_OAUTH_CLIENT_SECRET
//   NOTION_OAUTH_REDIRECT_URI
//   JWT_SECRET
//   NOTION_API_KEY  (for reading Settings DB)
//   WIDGET_BASE_URL (e.g. https://widgets.opxio.io/widgets/sales)

import { getClientByToken, getNotionToken } from '../../../lib/supabase.js'
import { signSession }                      from '../../../lib/session.js'
import { queryDB, DB }                      from '../../../lib/notion.js'

const SETTINGS_DB = DB.SETTINGS // '33ffe60097f681dfa394fc71e973ca91'

async function exchangeCode(code) {
  const clientId     = process.env.NOTION_OAUTH_CLIENT_ID
  const clientSecret = process.env.NOTION_OAUTH_CLIENT_SECRET
  const redirectUri  = process.env.NOTION_OAUTH_REDIRECT_URI

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  const r = await fetch('https://api.notion.com/v1/oauth/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type':  'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: JSON.stringify({
      grant_type:   'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  })
  if (!r.ok) throw new Error(`Token exchange failed: ${await r.text()}`)
  return r.json() // { access_token, token_type, bot_id, workspace_name, owner: { user: { ... } } }
}

async function getNotionUser(accessToken) {
  const r = await fetch('https://api.notion.com/v1/users/me', {
    headers: {
      'Authorization':  `Bearer ${accessToken}`,
      'Notion-Version': '2022-06-28',
    },
  })
  if (!r.ok) throw new Error(`users/me failed: ${await r.text()}`)
  return r.json() // { type: 'person', person: { email }, name, id, ... }
}

async function getApprovedEmails(notionKey) {
  // Query Settings DB for the QC Reviewer Emails record
  const rows = await queryDB(
    SETTINGS_DB,
    { property: 'Setting', title: { equals: 'QC Reviewer Emails' } },
    notionKey,
  )
  if (!rows.length) return []

  const val = (rows[0].properties?.['QC Reviewer Emails']?.rich_text || [])
    .map(t => t.plain_text).join('').trim()

  return val.split(/[\n,]+/).map(e => e.trim().toLowerCase()).filter(Boolean)
}

function widgetUrl(token, session) {
  const base = process.env.WIDGET_BASE_URL || 'https://widgets.opxio.io/widgets/sales'
  return `${base}/qc-review.html?token=${encodeURIComponent(token)}&session=${encodeURIComponent(session)}`
}

function errorPage(msg) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>*{margin:0;padding:0;box-sizing:border-box;}body{background:#191919;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:12px;}
h2{font-size:18px;font-weight:700;}p{font-size:13px;color:rgba(255,255,255,.5);max-width:360px;text-align:center;}</style>
</head><body><h2>Access Denied</h2><p>${msg}</p><p style="margin-top:8px;font-size:11px;">Close this tab and contact your workspace admin.</p></body></html>`
}

export async function handler(req, res) {
  const { code, state, error } = req.query

  if (error) {
    res.setHeader('Content-Type', 'text/html')
    return res.status(403).send(errorPage(`Notion authorisation was denied: ${error}`))
  }

  if (!code || !state) {
    res.setHeader('Content-Type', 'text/html')
    return res.status(400).send(errorPage('Missing OAuth code or state.'))
  }

  try {
    // 1. Decode state → get widget token
    let stateData
    try {
      stateData = JSON.parse(Buffer.from(state, 'base64url').toString())
    } catch (_) {
      throw new Error('Invalid state parameter')
    }
    const { token } = stateData
    if (!token) throw new Error('State missing widget token')

    // 2. Validate client
    const client = await getClientByToken(token)
    if (!client) throw new Error('Invalid widget token in state')
    const notionKey = getNotionToken(client)

    // 3. Exchange code for user access token
    const oauthData = await exchangeCode(code)
    const userAccessToken = oauthData.access_token

    // 4. Get Notion user email
    const user  = await getNotionUser(userAccessToken)
    const email = user?.person?.email || user?.bot?.owner?.user?.person?.email
    if (!email) throw new Error('Could not retrieve email from Notion account')

    // 5. Check approved reviewer list from Settings DB
    const approved = await getApprovedEmails(notionKey)
    if (approved.length && !approved.includes(email.toLowerCase())) {
      res.setHeader('Content-Type', 'text/html')
      return res.status(403).send(errorPage(`${email} is not an approved QC reviewer for this workspace.`))
    }

    // 6. Issue session token and redirect to widget
    const session = signSession(email, client.id)
    const dest    = widgetUrl(token, session)

    return res.redirect(302, dest)

  } catch (err) {
    console.error('[oauth-callback]', err)
    res.setHeader('Content-Type', 'text/html')
    return res.status(500).send(errorPage(err.message || 'Authentication failed.'))
  }
}
