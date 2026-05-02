// /api/data/accounts — token-authenticated
// Queries the Client Accounts DB and returns status counts, health breakdown, and client list

import { queryDB, plain, DB } from "../../lib/notion.js"
import { getClientByToken, getNotionToken, resolveDB, checkOrigin } from "../../lib/supabase.js"

export async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end()
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120")

  try {
    const accessToken = req.query.token || req.headers["x-widget-token"]
    if (!accessToken) return res.status(401).json({ error: "Missing token" })

    const client = await getClientByToken(accessToken)
    if (!client) return res.status(403).json({ error: "Invalid token" })
    if (!checkOrigin(client, req)) return res.status(403).json({ error: "Origin not allowed" })

    const notionToken = getNotionToken(client)
    const ACCOUNTS_DB = client?.databases?.["CLIENT_ACCOUNTS"] || client?.databases?.["client_accounts"] || resolveDB(client, "CLIENT_ACCOUNTS", DB.CLIENT_ACCOUNTS)

    const pages = await queryDB(ACCOUNTS_DB, null, notionToken)

    // Counters
    const statusCounts = { Onboarding: 0, Active: 0, "Past Client": 0 }
    const healthCounts = { "🟢 Healthy": 0, "🟡 Critical": 0, "🔴 At Risk": 0, Unset: 0 }
    let expansionCandidates = 0

    const clients = []

    for (const page of pages) {
      const p = page.properties

      const name       = plain(p["Account Name"]?.title || []) || "Untitled"
      const status     = p["Status"]?.select?.name || null
      const health     = p["Client Health"]?.select?.name || null
      const osInstalled = p["OS Installed"]?.multi_select?.map(x => x.name) || []
      const installDate = p["Install Date"]?.date?.start || null
      const handoverDate = p["Handover Date"]?.date?.start || null
      const lastTouchpoint = p["Last Touchpoint"]?.date?.start || null
      const expansionStage = p["Expansion Stage"]?.select?.name || null
      const expansionInterest = p["Expansion Interest"]?.multi_select?.map(x => x.name) || []
      const origin     = p["Client Origin"]?.select?.name || null
      const pageUrl    = `https://www.notion.so/${page.id.replace(/-/g, "")}`

      // Status counts
      if (status && status in statusCounts) statusCounts[status]++

      // Health counts
      if (health && health in healthCounts) healthCounts[health]++
      else if (!health) healthCounts["Unset"]++

      // Expansion
      if (expansionStage) expansionCandidates++

      clients.push({
        id: page.id,
        name,
        status,
        health,
        osInstalled,
        installDate,
        handoverDate,
        lastTouchpoint,
        expansionStage,
        expansionInterest,
        origin,
        url: pageUrl,
        createdTime: page.created_time,
      })
    }

    // Sort: Active first, then Onboarding, then Past Client — by install date desc within each
    const ORDER = { Active: 0, Onboarding: 1, "Past Client": 2 }
    clients.sort((a, b) => {
      const oa = ORDER[a.status] ?? 3
      const ob = ORDER[b.status] ?? 3
      if (oa !== ob) return oa - ob
      const da = a.installDate || a.createdTime || ""
      const db_ = b.installDate || b.createdTime || ""
      return db_.localeCompare(da)
    })

    res.status(200).json({
      total: pages.length,
      statusCounts,
      healthCounts,
      expansionCandidates,
      clients,
    })
  } catch (err) {
    console.error("accounts:", err)
    res.status(500).json({ error: err.message })
  }
}