/**
 * POST /api/creaitors/workspace-password
 *
 * Allows staff to change their workspace password.
 * On first login (must_change), also generates a backup code for self-service reset.
 *
 * Body: { staff_id, old_password, new_password }
 * Query: ?token=<client_access_token>
 *
 * Returns:
 *   200 { ok: true, backup_code?: "XXXX-XXXX" }  — backup_code only on first set
 *   401 { error: "wrong_password" }
 *   400 { error: "password_too_short" } (min 6 chars)
 */
import { getClientByToken, invalidateClientCache } from "../../lib/supabase.js"
import { createClient } from "@supabase/supabase-js"
import bcrypt from "bcryptjs"
import crypto from "crypto"

function getSb() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  )
}

function generateBackupCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I confusion
  let code = "";
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return code.slice(0, 4) + "-" + code.slice(4);
}

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

  const { staff_id, old_password, new_password } = req.body || {}
  if (!staff_id || !old_password || !new_password) {
    return res.status(400).json({ error: "missing_fields" })
  }

  if (new_password.length < 6) {
    return res.status(400).json({ error: "password_too_short" })
  }

  const staff = client.labels?.workspace_staff?.[staff_id]
  if (!staff) return res.status(404).json({ error: "staff_not_found" })

  const valid = bcrypt.compareSync(old_password, staff.password_hash)
  if (!valid) return res.status(401).json({ error: "wrong_password" })

  const isFirstSet = !!staff.must_change
  const newHash = bcrypt.hashSync(new_password, 10)

  const updatedStaff = {
    ...staff,
    password_hash: newHash,
    must_change: false
  }

  // Generate backup code on first password set
  let backupCode = null
  if (isFirstSet) {
    backupCode = generateBackupCode()
    updatedStaff.backup_code_hash = bcrypt.hashSync(backupCode.replace("-", ""), 10)
  }

  const labels = { ...client.labels }
  labels.workspace_staff = { ...labels.workspace_staff }
  labels.workspace_staff[staff_id] = updatedStaff

  const sb = getSb()
  const { error } = await sb.from("clients").update({ labels }).eq("id", client.id)
  if (error) {
    console.error("Password update failed:", error)
    return res.status(500).json({ error: "update_failed" })
  }

  invalidateClientCache(client.slug)

  const response = { ok: true }
  if (backupCode) response.backup_code = backupCode
  return res.json(response)
}