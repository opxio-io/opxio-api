// /api/data/team-tasks — Opxio internal cross-OS operations task hub
// GET: Returns task counts + active tasks + completed tasks with cross-OS context
import { queryDB, plain, hdrs } from "../../../lib/notion"
import { getClientByToken } from "../../../lib/supabase"

const TEAM_TASKS_DB = "345fe60097f6813da7a1c9087fb3a441"

async function fetchTitle(pageId, token) {
  try {
    const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, { headers: hdrs(token) })
    if (!res.ok) return null
    const data = await res.json()
    for (const prop of Object.values(data.properties || {})) {
      if (prop?.type === "title" && prop.title?.length) return plain(prop.title)
    }
    return null
  } catch { return null }
}

export async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end()
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,x-widget-token")
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120")

  try {
    const accessToken = req.query.token || req.headers["x-widget-token"]
    if (!accessToken) return res.status(401).json({ error: "Missing token" })
    const client = await getClientByToken(accessToken)
    if (!client) return res.status(403).json({ error: "Invalid token" })

    // Team Tasks is always Opxio's own DB — use master token
    const notionToken = process.env.NOTION_API_KEY
    const strip = id => (id || "").replace(/-/g, "")

    const tasks = await queryDB(TEAM_TASKS_DB, null, notionToken)

    // ── Collect all unique relation page IDs ─────────────────────────────────
    // context resolution priority: Lead → Deal → Build → Invoice → Account → Company
    const relMeta = new Map() // strippedId → 'Lead'|'Deal'|'Build'|'Invoice'|'Account'|'Company'
    for (const t of tasks) {
      const p = t.properties
      const pairs = [
        [p.Lead?.relation?.[0]?.id,              "Lead"],
        [p.Deal?.relation?.[0]?.id,              "Deal"],
        [p["Client Build"]?.relation?.[0]?.id,   "Build"],
        [p.Invoice?.relation?.[0]?.id,           "Invoice"],
        [p["Client Account"]?.relation?.[0]?.id, "Account"],
        [p.Company?.relation?.[0]?.id,           "Company"],
      ]
      for (const [id, type] of pairs) {
        if (id) relMeta.set(strip(id), type)
      }
    }

    // ── Batch-fetch all relation titles ──────────────────────────────────────
    const titleMap = {}
    await Promise.all([...relMeta.keys()].map(async id => {
      const title = await fetchTitle(id, notionToken)
      if (title) titleMap[id] = title
    }))

    // ── Process tasks ─────────────────────────────────────────────────────────
    const counts = { todo: 0, inProgress: 0, blocked: 0, done: 0 }
    const active    = []
    const completed = []

    for (const t of tasks) {
      const p        = t.properties
      const name     = plain(p["Task Name"]?.title || []) || "Untitled"
      const rawStatus = p.Status?.status?.name || p.Status?.select?.name || "To Do"
      const priority  = p.Priority?.select?.name || ""
      const category  = p.Category?.select?.name || ""
      const dueDate   = p["Due Date"]?.date?.start || null
      const notionUrl = t.url || null

      // Assignees
      const assignees = (p["Assigned To"]?.people || []).map(u => ({
        name:   u.name || u.person?.email?.split("@")[0] || "?",
        initials: (u.name || "?").split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase(),
        avatar: u.avatar_url || null,
      }))

      // Resolve context — first filled relation in priority order
      const leadId    = strip(p.Lead?.relation?.[0]?.id              || "")
      const dealId    = strip(p.Deal?.relation?.[0]?.id              || "")
      const buildId   = strip(p["Client Build"]?.relation?.[0]?.id   || "")
      const invoiceId = strip(p.Invoice?.relation?.[0]?.id           || "")
      const accountId = strip(p["Client Account"]?.relation?.[0]?.id || "")
      const companyId = strip(p.Company?.relation?.[0]?.id           || "")

      let context = null
      const ctx = (type, id) => id && titleMap[id] ? { type, label: titleMap[id] } : null
      context = ctx("Lead", leadId) || ctx("Deal", dealId) || ctx("Build", buildId)
             || ctx("Invoice", invoiceId) || ctx("Account", accountId) || ctx("Company", companyId)

      // Map to bucket
      let bucket = "todo"
      if      (rawStatus === "In Progress") bucket = "inProgress"
      else if (rawStatus === "Blocked")     bucket = "blocked"
      else if (rawStatus === "Done")        bucket = "done"
      else if (rawStatus === "Cancelled")   bucket = "cancelled"

      if (bucket === "cancelled") continue // skip cancelled
      if (bucket !== "done") counts[bucket]++
      else counts.done++

      const entry = { name, status: bucket, rawStatus, priority, category, assignees, dueDate, notionUrl, context }

      if (bucket === "done") completed.push(entry)
      else active.push(entry)
    }

    // ── Sort ──────────────────────────────────────────────────────────────────
    const statusOrder = { blocked: 0, inProgress: 1, todo: 2 }
    const byDue = (a, b) => {
      if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate)
      return a.dueDate ? -1 : b.dueDate ? 1 : 0
    }
    active.sort((a, b) => {
      const d = (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9)
      return d !== 0 ? d : byDue(a, b)
    })
    completed.sort((a, b) => (b.dueDate || "").localeCompare(a.dueDate || ""))

    return res.status(200).json({ counts, tasks: active, completed })
  } catch (err) {
    console.error("team-tasks:", err)
    return res.status(500).json({ error: err.message })
  }
}