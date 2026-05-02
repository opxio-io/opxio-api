// ─── Notion API helpers ───────────────────────────────────────────────────

export const NOTION_VERSION = "2022-06-28"
export const NOTION_TOKEN   = process.env.NOTION_API_KEY

// ─── Database IDs ─────────────────────────────────────────────────────────
export const DB = {
  // ── Revenue OS ─────────────────────────────────────────────────────────────
  QUOTATIONS:    "b54fe60097f683e1930d012d635b14d5",
  LEADS:         "340fe60097f6810091cfe204a1c13f5f",   // new Leads DB (early-stage)
  DEALS:         "caafe60097f683398df40197eeedbffe",   // Deals DB (qualified → Delivered)
  CATALOGUE:          "0acfe60097f682568935013f42a876f9",
  COMPANY_PROFILE:    "610ad83c11fa4f248ffd7ddae1dd1d64",  // Company Profile (identity, branding, banking, doc defaults)
  INVOICE:       "b02fe60097f6823b901e81d600093692",
  RECEIPT:       "1b2fe60097f682ba85e8016fba51d654",
  EXPANSIONS:    "df89178ae1b8485ba442759f14a4df7f",
  FINANCE:       "33ffe60097f68126bf6ccb8c2d4d6892",  // Finance & Expense Tracker DB
  // EXPENSES key removed — merged into FINANCE (Finance & Expense Tracker)
  // ── Operations OS ──────────────────────────────────────────────────────────
  PROJECTS:      "842fe60097f68303b34e01a5432d24cc",
  PHASES:        "39ffe60097f682b4bf11814aadaf233f",
  TASKS:         "f6bfe60097f682b9a283010bfefd4acf",
  RETAINERS:     "33ffe60097f681539b9be971463cdbec",   // Retainer Management (new)
  SOPS:          "33ffe60097f681a5ac20f20378023cf9",   // SOP & Process Library (new)
  RESP_MATRIX:   "33ffe60097f681f5bb41faf6fd7a152c",  // Team Responsibility Matrix (new)
  CLIENT_IMPL:   "c1dfe60097f682f1b0f10142af6449d0",  // Implementation/Projects tracker
  CLIENT_INTAKE: "b4fb844d9433492bbafe63841bea913a",  // Client Implementation Form (onboarding intake)
  MEETINGS:      "f9ffe60097f68389a09981dfece9e98f",
  // ── Base OS ────────────────────────────────────────────────────────────────
  COMPANIES:     "725fe60097f682c09be901fe6ebb6b41",  // Client companies
  CONTACTS:      "b0afe60097f68265b93401fbc6f0fec4",  // Individual people / PICs (was: Clients)
  PIC_HISTORY:   "36efe60097f682d2b3410198d11714c7",
  OPXIO_DETAILS: "757fe60097f68222857f0146e495ffa0",
  TEAM:          "33ffe60097f68160a05cf07440ceaa06",  // Team & Staff Directory (new)
  SETTINGS:      "33ffe60097f681dfa394fc71e973ca91",  // Settings & Configuration (new)
  ACTIVITY_LOG:  "33ffe60097f68196a65dd2988228defc",  // Activity Log (new)
  // ── Task config is now in config/tasks.json — no template DBs needed ──────
  // ── Proposals CRM (Generate Proposal flow) ────────────────────────────────
  PROPOSALS:       "1ad661f2679047749d16d2767291a30f",  // Proposals CRM
  // ── Retention OS ──────────────────────────────────────────────────────────
  CLIENT_ACCOUNTS: "345fe60097f680a0a4cbdfd798e03d91",  // Client Accounts (post-install records)
  // ── Add-ons tracker ───────────────────────────────────────────────────────
  ADD_ONS:         "d6ef12d3fddf4527817f12dd61218861",   // Add-ons (per-client add-on records)
  // ── Team Tasks (cross-OS operational task hub) ────────────────────────────
  TEAM_TASKS:      "345fe60097f6813da7a1c9087fb3a441",  // Team Tasks DB
}

// ─── Headers factory ───────────────────────────────────────────────────────
export function hdrs(token) {
  return {
    "Authorization":  `Bearer ${token || NOTION_TOKEN}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type":   "application/json",
  }
}

// ─── Plain text from rich_text/title array ─────────────────────────────────
export function plain(arr = []) {
  return arr.map(t => t.plain_text || "").join("")
}

// ─── Get a property value from a Notion page ──────────────────────────────
export function getProp(page, key) {
  const prop = page?.properties?.[key]
  if (!prop) return null
  switch (prop.type) {
    case "title":        return plain(prop.title)
    case "rich_text":    return plain(prop.rich_text)
    case "number":       return prop.number ?? null
    case "select":       return prop.select?.name ?? null
    case "multi_select": return prop.multi_select?.map(s => s.name) ?? []
    case "status":       return prop.status?.name ?? null
    case "date":         return prop.date?.start ?? null
    case "checkbox":     return prop.checkbox ?? false
    case "url":          return prop.url ?? null
    case "email":        return prop.email ?? null
    case "phone_number": return prop.phone_number ?? null
    case "relation":     return prop.relation?.map(r => r.id) ?? []
    case "formula":      return prop.formula?.[prop.formula.type] ?? null
    case "rollup": {
      const r = prop.rollup
      if (r.type === "number") return r.number ?? null
      if (r.type === "array")  return r.array ?? []
      return null
    }
    case "files": {
      const files = prop.files ?? []
      if (!files.length) return null
      const f = files[0]
      return f.type === "external" ? f.external?.url : f.file?.url
    }
    default: return null
  }
}

// ─── Fetch a single Notion page ────────────────────────────────────────────
export async function getPage(pageId, token) {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    headers: hdrs(token),
  })
  if (!res.ok) throw new Error(`Notion getPage ${pageId}: ${res.status} ${await res.text()}`)
  return res.json()
}

// ─── Patch a Notion page ───────────────────────────────────────────────────
export async function patchPage(pageId, properties, token) {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method:  "PATCH",
    headers: hdrs(token),
    body:    JSON.stringify({ properties }),
  })
  if (!res.ok) throw new Error(`Notion patchPage ${pageId}: ${res.status} ${await res.text()}`)
  return res.json()
}

// ─── Create a Notion page ──────────────────────────────────────────────────
export async function createPage(body, token) {
  const res = await fetch("https://api.notion.com/v1/pages", {
    method:  "POST",
    headers: hdrs(token),
    body:    JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Notion createPage: ${res.status} ${await res.text()}`)
  return res.json()
}

// ─── Query a database (all pages, handles pagination) ─────────────────────
export async function queryDB(dbId, filter, token) {
  const pages = []
  let cursor  = undefined
  do {
    const body = { page_size: 100 }
    if (filter) body.filter = filter
    if (cursor) body.start_cursor = cursor
    const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method:  "POST",
      headers: hdrs(token),
      body:    JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`Notion queryDB ${dbId}: ${res.status} ${await res.text()}`)
    const data = await res.json()
    pages.push(...data.results)
    cursor = data.has_more ? data.next_cursor : undefined
  } while (cursor)
  return pages
}

// ─── Rich text helper ──────────────────────────────────────────────────────
export function rt(text, opts = {}) {
  return {
    type: "text",
    text: { content: text || "" },
    annotations: opts,
  }
}

// ─── Format date DD MMM YYYY ───────────────────────────────────────────────
export function fmtDate(iso) {
  if (!iso) return "—"
  try {
    return new Date(iso).toLocaleDateString("en-GB", {
      day: "2-digit", month: "long", year: "numeric"
    })
  } catch { return iso }
}

// ─── Create a Finance Ledger entry ────────────────────────────────────────
// Wraps createPage for the Finance DB. Never throws — failure is logged only.
export async function createLedgerEntry({
  title,
  amount,
  category,       // "Client Deposit" | "Client Final Payment" | "Add-on Revenue" | "Retainer" | ...
  source,         // "Client Payment" | "Retainer Payment" | "Internal Expense" | ...
  payment,        // "Bank Transfer" | "Cash" | "Online Transfer" | ...
  status,         // "Received" | "Pending" | "Paid" | "Reconciled"
  date,           // ISO string YYYY-MM-DD
  invoiceId,      // Notion page ID (no dashes)
  projectId,      // Notion page ID (no dashes)
  notes,
}, token) {
  try {
    const today = new Date().toISOString().split("T")[0]
    const props = {
      "Title":    { title: [{ text: { content: title || "Untitled" } }] },
      "Amount":   { number: amount || 0 },
      "Category": { select: { name: category || "Client Deposit" } },
      "Source":   { select: { name: source   || "Client Payment" } },
      "Payment":  { select: { name: payment  || "Bank Transfer" } },
      "Status":   { select: { name: status   || "Received" } },
      "Date":     { date:   { start: date    || today } },
    }
    if (invoiceId) props["Invoice"] = { relation: [{ id: invoiceId }] }
    if (projectId) props["Project"] = { relation: [{ id: projectId }] }
    if (notes)     props["Notes"]   = { rich_text: [{ text: { content: notes } }] }

    return await createPage({
      parent:     { database_id: DB.FINANCE },
      properties: props,
    }, token)
  } catch (e) {
    console.warn("[createLedgerEntry] non-fatal:", e.message)
    return null
  }
}

// ─── Fetch Opxio company details ───────────────────────────────────────────
export async function fetchCompanyDetails(token) {
  try {
    const pages = await queryDB(DB.OPXIO_DETAILS, undefined, token)
    if (!pages.length) return {}
    const page = pages[0]
    const p    = page.properties

    // Logo: try page icon first, then files property
    let logoUrl = ""
    const icon  = page.icon || {}
    if (icon.type === "external") logoUrl = icon.external?.url || ""
    else if (icon.type === "file") logoUrl = icon.file?.url || ""

    if (!logoUrl) {
      for (const name of ["Logo", "Brand Logo", "logo", "Brand"]) {
        const prop = p[name]
        if (prop?.type === "files" && prop.files?.length) {
          const f = prop.files[0]
          logoUrl = f.type === "external" ? f.external?.url : f.file?.url
          if (logoUrl) break
        }
      }
    }

    return {
      name:               getProp(page, "Name"),
      email:              getProp(page, "Email"),
      phone:              getProp(page, "Phone"),
      bankName:           getProp(page, "Bank Name"),
      bankAccountHolder:  getProp(page, "Bank Account Holder Name"),
      bankNumber:         getProp(page, "Bank Number"),
      paymentMethod:      getProp(page, "Payment Method"),
      termsUrl:           getProp(page, "Terms URL"),
      logoUrl,
    }
  } catch (e) {
    console.warn("[company details]", e.message)
    return {}
  }
}

// ─── Create a Team Task (cross-OS pipeline automation) ────────────────────
// Always uses master NOTION_API_KEY — Team Tasks is Opxio-internal.
// Never throws — failure is logged and silently swallowed.
//
// taskName    string   — full task title
// category    string   — "Sales" | "Billing" | "Client" | "Admin" | "HR" | "Marketing" | "Finance" | "Internal"
// priority    string   — "High" | "Medium" | "Low"  (default: "Medium")
// dueDate     string   — ISO date YYYY-MM-DD (default: tomorrow)
// leadId      string   — Notion page ID (no dashes), sets Lead relation
// dealId      string   — Notion page ID, sets Deal relation
// projectId   string   — Notion page ID, sets Client Build relation
// invoiceId   string   — Notion page ID, sets Invoice relation
// companyId   string   — Notion page ID, sets Company relation
// accountId   string   — Notion page ID, sets Client Account relation
export async function createTeamTask({
  taskName,
  category,
  priority  = "Medium",
  dueDate,
  leadId,
  dealId,
  projectId,
  invoiceId,
  companyId,
  accountId,
} = {}) {
  try {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split("T")[0]
    const due      = dueDate || tomorrow

    const props = {
      "Task Name": { title: [{ text: { content: taskName || "Untitled Task" } }] },
      "Status":    { status: { name: "To Do" } },
      "Category":  { select: { name: category || "Admin" } },
      "Priority":  { select: { name: priority } },
      "Due Date":  { date:   { start: due } },
    }

    if (leadId)    props["Lead"]           = { relation: [{ id: leadId    }] }
    if (dealId)    props["Deal"]           = { relation: [{ id: dealId    }] }
    if (projectId) props["Client Build"]   = { relation: [{ id: projectId }] }
    if (invoiceId) props["Invoice"]        = { relation: [{ id: invoiceId }] }
    if (companyId) props["Company"]        = { relation: [{ id: companyId }] }
    if (accountId) props["Client Account"] = { relation: [{ id: accountId }] }

    const task = await createPage({
      parent:     { database_id: DB.TEAM_TASKS },
      properties: props,
    }, process.env.NOTION_API_KEY)

    console.log("[createTeamTask] Created:", taskName, "→", task?.id)
    return task
  } catch (e) {
    console.warn("[createTeamTask] non-fatal:", e.message)
    return null
  }
}

// ── Currency helper — reads Billing Currency from Company record ──────────
// Returns ISO currency code (e.g. "MYR", "USD", "SGD").
// Falls back to "MYR" if company not found or field unset.
export async function getCurrency(companyId, token) {
  if (!companyId) return "MYR"
  try {
    const page = await getPage(companyId, token)
    return page.properties["Billing Currency"]?.select?.name || "MYR"
  } catch { return "MYR" }
}
