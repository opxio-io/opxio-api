// /api/data/internal-builds — Opxio internal use only
// GET: Returns internal build counts and build list with task summaries
import { queryDB, plain } from "../../lib/notion.js"
import { getClientByToken } from "../../lib/supabase.js"

const INTERNAL_BUILDS_DB    = "0668c442d6ec4b848ed732236236ad5c"
const INTERNAL_BUILD_TASKS_DB = "e681e30141714b5da312a0f418cccf98"

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

    // Always use the Opxio master Notion token — these are internal Opxio DBs, not client DBs
    const notionToken = process.env.NOTION_API_KEY
    const strip = id => (id || "").replace(/-/g, "")

    // Fetch both DBs in parallel
    const [builds, tasks] = await Promise.all([
      queryDB(INTERNAL_BUILDS_DB,     null, notionToken),
      queryDB(INTERNAL_BUILD_TASKS_DB, null, notionToken),
    ])

    // Build reverse map: buildId → task summary
    const buildTaskMap = {}
    for (const t of tasks) {
      const p = t.properties
      const status = p.Status?.select?.name || "To Do"
      for (const rel of (p.Build?.relation || [])) {
        const bid = strip(rel.id)
        if (!buildTaskMap[bid]) buildTaskMap[bid] = { total: 0, done: 0, inProgress: 0, blocked: 0, notStarted: 0 }
        const m = buildTaskMap[bid]
        m.total++
        if      (status === "Done")        m.done++
        else if (status === "In Progress") m.inProgress++
        else if (status === "Blocked")     m.blocked++
        else                               m.notStarted++
      }
    }

    const counts = { planning: 0, inProgress: 0, done: 0, onHold: 0 }
    const active    = []
    const completed = []

    for (const b of builds) {
      const p         = b.properties
      const name      = plain(p["Build Name"]?.title || []) || "Untitled"
      const rawStatus = p.Status?.select?.name || ""
      const type      = p.Type?.select?.name || ""
      const priority  = p.Priority?.select?.name || ""
      const startDate  = p["Start Date"]?.date?.start  || null
      const targetDate = p["Target Date"]?.date?.start || null
      const notionUrl  = b.url || null
      const bid        = strip(b.id)

      const taskSummary = buildTaskMap[bid] || { total: 0, done: 0, inProgress: 0, blocked: 0, notStarted: 0 }
      const overallPct  = taskSummary.total > 0 ? Math.round((taskSummary.done / taskSummary.total) * 100) : 0

      // Map to bucket
      let bucket = "planning"
      if      (rawStatus.includes("In Progress")) { bucket = "inProgress"; counts.inProgress++ }
      else if (rawStatus.includes("Done"))        { bucket = "done";       counts.done++ }
      else if (rawStatus.includes("Hold"))        { bucket = "onHold";     counts.onHold++ }
      else                                        { bucket = "planning";   counts.planning++ }

      const entry = { name, type, priority, status: bucket, rawStatus, startDate, targetDate, notionUrl, taskSummary, overallPct }

      if (bucket === "done") completed.push(entry)
      else active.push(entry)
    }

    // Sort active: in-progress first, then planning, then on-hold
    const order = { inProgress: 0, planning: 1, onHold: 2 }
    active.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9))
    completed.sort((a, b) => (b.targetDate || "").localeCompare(a.targetDate || ""))

    return res.status(200).json({ counts, builds: active, completed })
  } catch (err) {
    console.error("internal-builds:", err)
    return res.status(500).json({ error: err.message })
  }
}