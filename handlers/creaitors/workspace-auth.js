/**
 * POST /api/creaitors/workspace-auth
 *
 * Verifies a staff member's workspace password.
 * Body: { staff_id, password }
 * Query: ?token=<client_access_token>
 *
 * Returns:
 *   200 { ok: true, name, page, must_change }
 *   401 { error: "wrong_password" }
 *   404 { error: "staff_not_found" }
 */
import { getClientByToken } from "../../lib/supabase.js"
import bcrypt from "bcryptjs"

export async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if (req.method === "OPTIONS") return res.status(200).end()
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" })

  const token = req.query.token || req.headers["x-widget-token"]
  if (!token) return res.status(401).json({ error: "missing_token" })

  const client = await getClientByToken(token)
  if (!client) return res.status(403).json({ error: "invalid_token" })

  const { staff_id, password } = req.body || {}
  if (!staff_id || !password) return res.status(400).json({ error: "missing_fields" })

  const staff = client.labels?.workspace_staff?.[staff_id]
  if (!staff) return res.status(404).json({ error: "staff_not_found" })

  const valid = bcrypt.compareSync(password, staff.password_hash)
  if (!valid) return res.status(401).json({ error: "wrong_password" })

  return res.json({
    ok: true,
    name: staff.name,
    page: staff.page,
    must_change: !!staff.must_change
  })
}