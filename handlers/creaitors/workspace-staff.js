/**
 * GET /api/creaitors/workspace-staff
 *
 * Returns the list of staff members (name, dept, id) for the workspace gate dropdown.
 * No passwords or hashes exposed.
 * Query: ?token=<client_access_token>
 */
import { getClientByToken } from "../../../lib/supabase"

export async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=30")
  if (req.method === "OPTIONS") return res.status(200).end()

  const token = req.query.token || req.headers["x-widget-token"]
  if (!token) return res.status(401).json({ error: "missing_token" })

  const client = await getClientByToken(token)
  if (!client) return res.status(403).json({ error: "invalid_token" })

  const ws = client.labels?.workspace_staff
  if (!ws) return res.json({ staff: [] })

  const staff = Object.entries(ws).map(([id, s]) => ({
    id,
    name: s.name,
    dept: s.dept
  }))

  // Sort by department then name
  staff.sort((a, b) => a.dept.localeCompare(b.dept) || a.name.localeCompare(b.name))

  return res.json({ staff })
}