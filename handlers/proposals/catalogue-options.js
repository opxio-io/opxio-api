// pages/api/proposals/catalogue-options.js
// GET — returns OS types from Catalogue DB for the proposal editor dropdown.
// Internal use only — no client auth required.

import { fetchCatalogueForProposal } from "../../lib/catalogue.js"

export async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).end()

  try {
    const { osOptions } = await fetchCatalogueForProposal(process.env.NOTION_API_KEY)
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120")
    return res.status(200).json({ osOptions })
  } catch (e) {
    console.error("[catalogue-options]", e.message)
    return res.status(500).json({ error: e.message })
  }
}