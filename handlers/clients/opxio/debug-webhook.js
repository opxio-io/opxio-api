// ─── debug-webhook.js ─────────────────────────────────────────────────────
// POST /api/clients/opxio/debug-webhook
// Echoes back the full request body — used to diagnose Notion button payloads.
// Remove after debugging.

export async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const snapshot = {
    method:  req.method,
    headers: req.headers,
    body:    req.body,
    query:   req.query,
  }
  console.log('[debug-webhook]', JSON.stringify(snapshot, null, 2))
  return res.status(200).json({ ok: true, received: snapshot })
}
