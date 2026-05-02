// /api/data/settings-update — Opxio internal only
// Updates the Value field on a Settings & Configuration record

import { getClientByToken, getNotionToken, checkOrigin } from "../../../lib/supabase"

const NOTION_API     = "https://api.notion.com/v1"
const NOTION_VERSION = "2022-06-28"

export async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end()
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Cache-Control", "no-store")

  if (req.method !== "POST" && req.method !== "PATCH") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  try {
    const accessToken = req.query.token || req.headers["x-widget-token"]
    if (!accessToken) return res.status(401).json({ error: "Missing token" })

    const client = await getClientByToken(accessToken)
    if (!client) return res.status(403).json({ error: "Invalid token" })
    if (!checkOrigin(client, req)) return res.status(403).json({ error: "Origin not allowed" })

    const { pageId, value } = req.body
    if (!pageId || value === undefined) return res.status(400).json({ error: "Missing pageId or value" })

    const notionToken = getNotionToken(client)

    const r = await fetch(`${NOTION_API}/pages/${pageId}`, {
      method: "PATCH",
      headers: {
        "Authorization": `Bearer ${notionToken}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        properties: {
          Value: {
            rich_text: [{ type: "text", text: { content: String(value) } }],
          },
        },
      }),
    })

    if (!r.ok) {
      const err = await r.text()
      return res.status(r.status).json({ error: err })
    }

    res.status(200).json({ ok: true })
  } catch (err) {
    console.error("settings-update:", err)
    res.status(500).json({ error: err.message })
  }
}