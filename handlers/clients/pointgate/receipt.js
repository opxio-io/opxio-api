// handlers/clients/pointgate/receipt.js
// Upload a payment receipt to Vercel Blob and store the URL in Notion.
// POST /api/clients/pointgate/receipt
// Body: { pageId, file: "data:<mime>;base64,<data>", fileName }

import { uploadBlob }                   from '../../../lib/blob.js'
import { patchPage }                    from '../../../lib/notion.js'
import { cacheDelete, cacheKey }        from '../../../lib/cache.js'

const NOTION_KEY   = () => process.env.POINTGATE_NOTION_KEY || process.env.NOTION_API_KEY
const DASHBOARD_CK = cacheKey('pointgate', 'dashboard', 'v4')

const ALLOWED_TYPES = new Set([
  'image/jpeg','image/jpg','image/png','image/webp','image/heic',
  'application/pdf',
])

export async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const { pageId, file, fileName } = req.body || {}

  if (!pageId || !file) return res.status(400).json({ error: 'pageId and file required' })

  // Parse data URL: data:<mime>;base64,<data>
  const match = file.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) return res.status(400).json({ error: 'file must be a base64 data URL' })

  const [, mimeType, b64] = match
  if (!ALLOWED_TYPES.has(mimeType))
    return res.status(400).json({ error: `Unsupported file type: ${mimeType}` })

  const buffer = Buffer.from(b64, 'base64')
  const sizeMB = buffer.byteLength / 1_048_576

  if (sizeMB > 10) return res.status(400).json({ error: 'File too large (max 10 MB)' })

  try {
    // Build safe filename
    const ext  = mimeType.split('/')[1].replace('jpeg','jpg')
    const safe = (fileName || 'receipt').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40)
    const path = `pointgate/receipts/${safe}_${Date.now()}.${ext}`

    const { url } = await uploadBlob(path, buffer, mimeType)
    console.log(`[pointgate:receipt] Uploaded: ${url}`)

    // Normalise page ID (add dashes if missing)
    const normalId = pageId.replace(/-/g, '').replace(
      /^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'
    )

    const token = NOTION_KEY()
    await patchPage(normalId, { 'Receipt URL': { url } }, token)
    console.log(`[pointgate:receipt] Patched page ${normalId}`)

    // Bust cache
    cacheDelete(DASHBOARD_CK)

    res.json({ ok: true, url })
  } catch (err) {
    console.error('[pointgate:receipt] error:', err.message)
    res.status(500).json({ error: err.message })
  }
}
