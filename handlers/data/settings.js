// /api/data/settings — token-authenticated, Opxio internal
// Returns all Settings & Configuration records grouped by Category

import { queryDB, plain, DB } from "../../lib/notion.js"
import { getClientByToken, getNotionToken, resolveDB, checkOrigin } from "../../lib/supabase.js"

export async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end()
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Cache-Control", "no-store")

  try {
    const accessToken = req.query.token || req.headers["x-widget-token"]
    if (!accessToken) return res.status(401).json({ error: "Missing token" })

    const client = await getClientByToken(accessToken)
    if (!client) return res.status(403).json({ error: "Invalid token" })
    if (!checkOrigin(client, req)) return res.status(403).json({ error: "Origin not allowed" })

    const notionToken  = getNotionToken(client)
    const SETTINGS_DB  = resolveDB(client, "SETTINGS", DB.SETTINGS)

    const pages = await queryDB(SETTINGS_DB, null, notionToken)

    const CATEGORY_ORDER = ["Business", "Finance", "Document", "Integration", "Notification"]

    const grouped = {}
    for (const page of pages) {
      const p        = page.properties
      const setting  = plain(p.Setting?.title || [])
      const value    = p.Value?.rich_text?.[0]?.plain_text || ""
      const category = p.Category?.select?.name || "Other"
      const notes    = p.Notes?.rich_text?.[0]?.plain_text || ""

      if (!setting) continue
      if (!grouped[category]) grouped[category] = []
      grouped[category].push({ id: page.id, setting, value, notes })
    }

    // Sort each category alphabetically by setting name
    for (const cat of Object.keys(grouped)) {
      grouped[cat].sort((a, b) => a.setting.localeCompare(b.setting))
    }

    const categories = CATEGORY_ORDER
      .filter(c => grouped[c])
      .map(c => ({ name: c, settings: grouped[c] }))

    // Append any unexpected categories at the end
    for (const c of Object.keys(grouped)) {
      if (!CATEGORY_ORDER.includes(c)) {
        categories.push({ name: c, settings: grouped[c] })
      }
    }

    res.status(200).json({ categories })
  } catch (err) {
    console.error("settings:", err)
    res.status(500).json({ error: err.message })
  }
}