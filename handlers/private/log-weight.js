// /api/private/log-weight
// Logs a new weight entry to the Weight Log DB

import { createPage, hdrs } from "../../../lib/notion"

const WEIGHT_LOG_DB = "43b574d8273a4ac3ac101e9eddcac4e6"

export async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-widget-token")
  if (req.method === "OPTIONS") return res.status(200).end()

  const token = req.query.token || req.headers["x-widget-token"]
  const validToken = process.env.PRIVATE_WIDGET_TOKEN || "kai-journey-2026"
  if (!token || token !== validToken) return res.status(403).json({ error: "Forbidden" })
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" })

  try {
    const notionToken = process.env.NOTION_API_KEY
    const { weight, height, notes, date } = req.body

    if (!weight || isNaN(parseFloat(weight))) {
      return res.status(400).json({ error: "Valid weight is required" })
    }

    const logDate = date || new Date().toISOString().split("T")[0]
    const w       = parseFloat(weight)
    const name    = `${w} kg — ${logDate}`

    const props = {
      "Name":         { title: [{ text: { content: name } }] },
      "Date":         { date:  { start: logDate } },
      "Weight (kg)":  { number: w },
    }
    if (height && !isNaN(parseFloat(height))) {
      props["Height (cm)"] = { number: parseFloat(height) }
    }
    if (notes) {
      props["Notes"] = { rich_text: [{ text: { content: notes } }] }
    }

    const page = await createPage({
      parent:     { database_id: WEIGHT_LOG_DB },
      properties: props,
    }, notionToken)

    res.status(200).json({ success: true, id: page.id, weight: w, date: logDate })
  } catch (err) {
    console.error("[log-weight]", err)
    res.status(500).json({ error: err.message })
  }
}