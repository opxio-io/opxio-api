/**
 * POST /api/creaitors/workspace-self-reset
 *
 * Self-service password reset via backup code.
 *
 * Body: { staff_id, backup_code, new_password }
 * Query: ?token=<client_access_token>
 *
 * Returns:
 *   200 { ok: true, new_backup_code: "XXXX-XXXX" }
 *   401 { error: "wrong_code" }
 *   400 { error: "no_backup_code" } — staff hasn't set one yet (never completed first login)
 */
import { invalidateClientCache } from "../../lib/supabase.js"
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
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
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

  // Read fresh from DB — security-sensitive, no cache
  const sb = getSb()
  const { data: client, error: cErr } = await sb
    .from("clients").select("*")
    .eq("access_token", token).eq("status", "active").single()
  if (cErr || !client) return res.status(403).json({ error: "invalid_token" })

  const { staff_id, backup_code, new_password } = req.body || {}
  if (!staff_id || !backup_code || !new_password) {
    return res.status(400).json({ error: "missing_fields" })
  }
  if (new_password.length < 6) {
    return res.status(400).json({ error: "password_too_short" })
  }

  const staff = client.labels?.workspace_staff?.[staff_id]
  if (!staff) return res.status(404).json({ error: "staff_not_found" })

  if (!staff.backup_code_hash) {
    return res.status(400).json({ error: "no_backup_code" })
  }

  // Normalize: strip spaces/dashes, uppercase
  const normalized = backup_code.replace(/[\s-]/g, "").toUpperCase()
  const valid = bcrypt.compareSync(normalized, staff.backup_code_hash)
  if (!valid) return res.status(401).json({ error: "wrong_code" })

  // Reset password and issue a new backup code
  const newBackupCode = generateBackupCode()
  const newHash = bcrypt.hashSync(new_password, 10)
  const newBackupHash = bcrypt.hashSync(newBackupCode.replace("-", ""), 10)

  const labels = { ...client.labels }
  labels.workspace_staff = { ...labels.workspace_staff }
  labels.workspace_staff[staff_id] = {
    ...staff,
    password_hash: newHash,
    backup_code_hash: newBackupHash,
    must_change: false
  }

  const { error } = await sb.from("clients").update({ labels }).eq("id", client.id)
  if (error) return res.status(500).json({ error: "update_failed" })
  invalidateClientCache(client.slug)

  return res.json({ ok: true, new_backup_code: newBackupCode })
}