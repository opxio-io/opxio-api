// lib/catalogue.js
// Server-side Catalogue helpers for proposal rendering + editor population.
// Uses process.env.NOTION_API_KEY directly — no client auth needed.

import { queryDB, plain, DB } from "./notion.js"

/**
 * Fetch catalogue data shaped for proposal use.
 *
 * Returns:
 *   osOptions    — [{ name, tier, order }]
 *                  Tier "OS Package" = core OS (Revenue, Operations, Marketing, Finance)
 *                  Tier "Additional OS Layer" = Team, Retention, Sales
 *
 *   modulesByOs  — { [osName]: [{ name, desc, order }] }
 *                  Tier "Core Module" items, keyed by each "Available To" OS name
 */
export async function fetchCatalogueForProposal(token) {
  const rows = await queryDB(
    DB.CATALOGUE,
    { property: "Status", select: { equals: "Active" } },
    token
  )

  const osOptions   = []
  const modulesByOs = {}

  for (const page of rows) {
    const pp    = page.properties
    const name  = plain(pp["Product Name"]?.title || [])
    const tier  = pp["Tier"]?.select?.name || ""
    const desc  = plain(pp["Description"]?.rich_text || [])
    const order = pp["Order"]?.number ?? 999
    const avail = (pp["Available To"]?.multi_select || []).map(x => x.name)

    if (!name) continue

    if (tier === "OS Package" || tier === "Additional OS Layer") {
      osOptions.push({ name, tier, order })
    } else if (tier === "Core Module") {
      for (const os of avail) {
        if (!modulesByOs[os]) modulesByOs[os] = []
        modulesByOs[os].push({ name, desc, order })
      }
    }
  }

  osOptions.sort((a, b) => a.order - b.order)
  for (const os of Object.keys(modulesByOs)) {
    modulesByOs[os].sort((a, b) => a.order - b.order)
  }

  return { osOptions, modulesByOs }
}
