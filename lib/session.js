// ─── session.js ────────────────────────────────────────────────────────────
// Lightweight signed session tokens using Node crypto (no external deps).
// Format: base64url(payload).HMAC-SHA256(payload, JWT_SECRET)
// Payload: { email, clientId, exp }

import { createHmac } from 'crypto'

const SECRET = () => process.env.JWT_SECRET || 'opxio-dev-secret'
const TTL_MS = 8 * 60 * 60 * 1000 // 8 hours

export function signSession(email, clientId) {
  const payload = Buffer.from(JSON.stringify({
    email,
    clientId,
    exp: Date.now() + TTL_MS,
  })).toString('base64url')
  const sig = createHmac('sha256', SECRET()).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

export function verifySession(token) {
  if (!token) throw new Error('No session token')
  const dot = token.lastIndexOf('.')
  if (dot === -1) throw new Error('Malformed token')
  const payload = token.slice(0, dot)
  const sig     = token.slice(dot + 1)
  const expected = createHmac('sha256', SECRET()).update(payload).digest('base64url')
  if (sig !== expected) throw new Error('Invalid session signature')
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString())
  if (Date.now() > data.exp) throw new Error('Session expired')
  return data // { email, clientId, exp }
}
