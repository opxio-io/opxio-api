// ─── auth-callback.js ─────────────────────────────────────────────────────
// GET /api/clients/opxio/auth/callback?code=...&state=...
// Notion OAuth callback — exchanges code, verifies reviewer access, issues session.

import { getClientByToken } from '../../../lib/supabase.js'
import { signSession }      from '../../../lib/session.js'

const CLIENT_ID     = () => process.env.NOTION_OAUTH_CLIENT_ID
const CLIENT_SECRET = () => process.env.NOTION_OAUTH_CLIENT_SECRET
const REDIRECT_URI  = 'https://api.opxio.io/api/clients/opxio/auth/callback'
const WIDGET_URL    = 'https://widgets.opxio.io/widgets/sales/qc-review.html'

const TEAM_DB = '345fe60097f68105b7bfc34e6a298e87'

function notionHdrs(token) {
  return {
    Authorization:    `Bearer ${token}`,
    'Notion-Version': '2022-06-28',
    'Content-Type':   'application/json',
  }
}

function errRedirect(res, widgetToken, msg) {
  const base = widgetToken ? `${WIDGET_URL}?token=${widgetToken}` : WIDGET_URL
  return res.redirect(`${base}&auth_error=${encodeURIComponent(msg)}`)
}

async function exchangeCode(code) {
  const creds = Buffer.from(`${CLIENT_ID()}:${CLIENT_SECRET()}`).toString('base64')
  const r = await fetch('https://api.notion.com/v1/oauth/token', {
    method: 'POST',
    headers: {
      Authorization:  `Basic ${creds}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      grant_type:   'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    }),
  })
  if (!r.ok) throw new Error(`Token exchange failed: ${await r.text()}`)
  return r.json() // { access_token, owner: { user: { id, name, person: { email } } }, workspace_id, ... }
}

async function isApprovedReviewer(email, notionKey) {
  const r = await fetch(`https://api.notion.com/v1/databases/${TEAM_DB}/query`, {
    method: 'POST',
    headers: notionHdrs(notionKey),
    body: JSON.stringify({
      filter: {
        and: [
          { property: 'Email',       rich_text: { contains: email } },
          { property: 'QC Reviewer', checkbox:  { equals: true    } },
        ],
      },
      page_size: 1,
    }),
  })
  if (!r.ok) return false
  const d = await r.json()
  return (d.results?.length || 0) > 0
}

export async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })

  const { code, state, error } = req.query

  // Decode state to recover widget token
  let widgetToken = ''
  try {
    const decoded = JSON.parse(Buffer.from(state || '', 'base64url').toString())
    widgetToken = decoded.token || ''
    // Reject stale states (>10 min)
    if (!decoded.ts || Date.now() - decoded.ts > 10 * 60 * 1000) {
      return errRedirect(res, widgetToken, 'OAuth state expired — please try again')
    }
  } catch {
    return errRedirect(res, widgetToken, 'Invalid OAuth state')
  }

  if (error) {
    return errRedirect(res, widgetToken, `Notion denied access: ${error}`)
  }
  if (!code) {
    return errRedirect(res, widgetToken, 'No authorisation code received')
  }

  // Validate widget token
  const client = await getClientByToken(widgetToken)
  if (!client) {
    return errRedirect(res, widgetToken, 'Widget token invalid')
  }

  try {
    // Exchange code → Notion access token + user info
    const tokenData = await exchangeCode(code)
    const userEmail = tokenData?.owner?.user?.person?.email || ''

    if (!userEmail) {
      return errRedirect(res, widgetToken, 'Could not retrieve email from Notion — ensure your account has an email set')
    }

    const normalEmail = userEmail.toLowerCase().trim()

    // Check QC Reviewer access via Team Directory
    const approved = await isApprovedReviewer(normalEmail, process.env.NOTION_API_KEY)
    if (!approved) {
      return errRedirect(res, widgetToken,
        `${normalEmail} is not authorised. Ask your workspace admin to enable QC Reviewer in the Team Directory.`)
    }

    // Issue session JWT (8h)
    const session = signSession(normalEmail, client.id)

    // Redirect back to widget with session
    return res.redirect(`${WIDGET_URL}?token=${widgetToken}&session=${encodeURIComponent(session)}&reviewer=${encodeURIComponent(normalEmail)}`)

  } catch (err) {
    console.error('[auth-callback]', err)
    return errRedirect(res, widgetToken, err.message || 'Authentication failed')
  }
}
