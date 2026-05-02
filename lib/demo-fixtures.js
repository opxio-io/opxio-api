// lib/demo-fixtures.js
// All mock data for the Opxio showcase/demo page.
// Returned by every /api/data/* endpoint when client.slug === 'demo'.
// ONE file — edit here and all widgets update automatically.

// ── /api/data/pipeline ───────────────────────────────────────────────────────
export const PIPELINE = {
  stages: {
    Incoming: 8, Contacted: 5, Qualified: 4,
    "Discovery Booked": 3, "Discovery Done": 6,
    Converted: 12, Lost: 3, Ghosted: 2, Unqualified: 1,
  },
  stageOrder: ["Incoming","Contacted","Qualified","Discovery Booked","Discovery Done","Converted","Lost","Ghosted","Unqualified"],
  activeStages: ["Incoming","Contacted","Qualified","Discovery Booked","Discovery Done"],
  totalActive: 26,
  thisMonthLeads: 11, thisMonthConverted: 4, thisMonthLost: 1,
  thisMonthWon: 4, convRate: 80, winRate: 80,
  followUpsDueToday: 2, followUpsOverdue: 1,
  leadsPotentialValue: 48500, lostLeadsValue: 9750, lostLeadsValueThisMonth: 3250,
  lostLabel: "Lost", lostLabels: ["Lost","Ghosted","Unqualified"],
  totalLostLeads: 6,
  sources: [
    { label: "Instagram DM", count: 7 },
    { label: "Referral Direct", count: 5 },
    { label: "Website Form", count: 4 },
    { label: "LinkedIn DM", count: 3 },
  ],
  countries: [{ label: "Malaysia", count: 18 }, { label: "Singapore", count: 8 }],
  monthly: [
    { m: "Nov", v: 4 }, { m: "Dec", v: 6 }, { m: "Jan", v: 9 },
    { m: "Feb", v: 7 }, { m: "Mar", v: 10 }, { m: "Apr", v: 11 },
  ],
  board: [
    { stage: "Incoming", leads: [
      { name: "Azim Harun — Creaitors Official", pkg: "Business OS" },
      { name: "Syafiq Ismail — Brandwell Studio", pkg: "Revenue OS" },
      { name: "Hafiz Zain — Motion Creative", pkg: "Operations OS" },
    ]},
    { stage: "Discovery Booked", leads: [
      { name: "Sarah Lim — The Content Co", pkg: "Marketing OS" },
      { name: "Danial Faris — Pulse Agency", pkg: "Business OS" },
      { name: "Rizal Amran — Forge Media", pkg: "Revenue OS" },
    ]},
    { stage: "Discovery Done", leads: [
      { name: "Nadia K — Studio Republic", pkg: "Business OS" },
      { name: "Reza Amin — Collective KL", pkg: "Operations OS" },
    ]},
  ],
  lostLeads: [
    { name: "RandomCo — Revenue OS", value: 3250, lostReason: "Budget Constraints", stage: "Lost" },
    { name: "TestBiz — Operations OS", value: 3250, lostReason: "Not Ready", stage: "Ghosted" },
  ],
  stageValues: { Incoming: 26000, Contacted: 16250, Qualified: 13000, "Discovery Booked": 9750, "Discovery Done": 19500, Converted: 39000, Lost: 9750, Ghosted: 6500, Unqualified: 3250 },
  utm: { sources: [], mediums: [], campaigns: [] },
}

// ── /api/data/deals ──────────────────────────────────────────────────────────
export const DEALS = {
  stages: {
    Proposal: 3, Negotiation: 2, "Proposal Sent": 2,
    "Quotation Issued": 1, "Awaiting Deposit": 2,
    "Closed-Won": 4, "Balance Due": 1, Delivered: 9, "Closed-Lost": 2,
  },
  stageOrder: ["Proposal","Negotiation","Proposal Sent","Quotation Issued","Awaiting Deposit","Closed-Won","Balance Due","Delivered","Closed-Lost"],
  potentialStages: ["Proposal","Negotiation","Proposal Sent","Quotation Issued","Awaiting Deposit"],
  wonStages: ["Closed-Won","Balance Due","Delivered"],
  potentialValue: 42000, buildingValue: 58500,
  activeDealsCount: 5,
  deliveryStage: "Building", deliveryCount: 4,
  balanceStage: "Balance Due", balanceCount: 1,
  totalLostDeals: 2, lostThisMonth: 0,
  lostLabel: "Closed-Lost", lostLabels: ["Closed-Lost"],
  wonThisMonth: 2, deliveredThisMonth: 1,
  wonValue: 58500, lostValue: 6500,
  proposals: { total: 5, Draft: 1, "Ready to Send": 0, Sent: 2, Accepted: 2, Rejected: 0, pipelineValue: 36000 },
  quotations: { total: 8, Draft: 2, Issued: 3, Approved: 2, Rejected: 1 },
  wonDeals: [
    { name: "Creaitors Official — Business OS Build", value: 9000, stage: "Building", pkg: "Business OS" },
    { name: "Brandwell Studio — Revenue OS Build", value: 3250, stage: "Building", pkg: "Revenue OS" },
    { name: "Motion Creative — Operations OS Build", value: 3250, stage: "Building", pkg: "Operations OS" },
    { name: "Pulse Agency — Business OS Build", value: 9000, stage: "Building", pkg: "Business OS" },
    { name: "The Content Co — Balance Due", value: 3250, stage: "Balance Due", pkg: "Revenue OS" },
  ],
  lostDeals: [
    { name: "RandomCo — Revenue OS", value: 3250, lostReason: "Budget Constraints", pkg: "Revenue OS" },
    { name: "TestBiz — Operations OS", value: 3250, lostReason: "Not Ready", pkg: "Operations OS" },
  ],
  board: [
    { stage: "Incoming", deals: [
      { name: "Forge Media — Revenue OS", value: 3250, pkg: "Revenue OS" },
      { name: "Luminary Studio — Operations OS", value: 3250, pkg: "Operations OS" },
    ]},
    { stage: "Proposal Sent", deals: [
      { name: "Studio Republic — Business OS", value: 9000, pkg: "Business OS" },
      { name: "Collective KL — Operations OS", value: 3250, pkg: "Operations OS" },
    ]},
    { stage: "Awaiting Deposit", deals: [
      { name: "Catalyst Agency — Revenue OS", value: 3250, pkg: "Revenue OS" },
      { name: "Venture Build — Business OS", value: 9000, pkg: "Business OS" },
    ]},
  ],
  stageValues: { Proposal: 9750, Negotiation: 6500, "Proposal Sent": 12250, "Quotation Issued": 3250, "Awaiting Deposit": 12250, "Closed-Won": 24500, "Balance Due": 3250, Delivered: 29250, "Closed-Lost": 6500 },
}

// ── /api/data/finance ────────────────────────────────────────────────────────
export const FINANCE = {
  quotations: { Draft: 2, Issued: 3, Approved: 5, Rejected: 1 },
  proposals: { total: 5, Draft: 1, Sent: 2, Accepted: 2, Rejected: 0, pipelineValue: 36000 },
  invoices: {
    depositPending: { count: 2, total: 9000 },
    balancePending: { count: 1, total: 4500 },
    paid: { count: 11, total: 72000 },
  },
  monthly: [
    { m: "Nov", v: 9000 }, { m: "Dec", v: 12500 }, { m: "Jan", v: 6500 },
    { m: "Feb", v: 15000 }, { m: "Mar", v: 18000 }, { m: "Apr", v: 16500 },
  ],
  thisMonth: {
    revenue: 16500, orders: 3, installs: 2, wonClients: 2,
    prevRevenue: 18000, prevInstalls: 3, prevWon: 2,
  },
  topProducts: [
    { name: "Business OS (Revenue OS + Operations OS)", count: 5, pct: 42, barPct: 100, cat: "os",      sub: "Revenue + Operations" },
    { name: "Revenue OS",        count: 4, pct: 33, barPct: 79,  cat: "os",      sub: "Lead to cash — full cycle" },
    { name: "Operations OS",     count: 3, pct: 25, barPct: 60,  cat: "os",      sub: "Workflow & delivery" },
    { name: "Enhanced Dashboard",count: 3, pct: 25, barPct: 60,  cat: "widgets", sub: "Charts, trends & KPI cards" },
    { name: "Marketing OS",      count: 2, pct: 17, barPct: 40,  cat: "os",      sub: "Campaigns, content & ads" },
  ],
}

// ── /api/data/finance-snapshot ───────────────────────────────────────────────
export const FINANCE_SNAPSHOT = {
  kpi: { thisMonthIncome: 16500, thisMonthExpenses: 4200, thisMonthPL: 12300 },
  categoryBreakdown: [
    { category: "Software & Tools", amount: 1800 },
    { category: "Freelance & Contractors", amount: 1200 },
    { category: "Ads & Marketing", amount: 700 },
    { category: "Office & Equipment", amount: 500 },
  ],
  monthlyTrend: [
    { m: "Nov", income: 9000, expenses: 3200, pl: 5800 },
    { m: "Dec", income: 12500, expenses: 4100, pl: 8400 },
    { m: "Jan", income: 6500, expenses: 2800, pl: 3700 },
    { m: "Feb", income: 15000, expenses: 4500, pl: 10500 },
    { m: "Mar", income: 18000, expenses: 5100, pl: 12900 },
    { m: "Apr", income: 16500, expenses: 4200, pl: 12300 },
  ],
}

// ── /api/data/projects (default + gantt + team views) ────────────────────────
const DEMO_PROJECTS_ACTIVE = [
  {
    id: "proj-001",
    name: "Creaitors Official — Business OS Build",
    client: "Creaitors Official",
    status: "In Progress",
    phase: "Phase 3 — Operations OS",
    progress: 65,
    startDate: "2026-02-01",
    targetDate: "2026-05-15",
    osScope: "Business OS",
    phases: [
      { no: 1, name: "Phase 1 — Base OS", status: "Done", tasks: { total: 5, done: 5, inProgress: 0, notStarted: 0 }, pct: 100 },
      { no: 2, name: "Phase 2 — Revenue OS", status: "Done", tasks: { total: 8, done: 8, inProgress: 0, notStarted: 0 }, pct: 100 },
      { no: 3, name: "Phase 3 — Operations OS", status: "In Progress", tasks: { total: 8, done: 4, inProgress: 2, notStarted: 2 }, pct: 50 },
      { no: 4, name: "Phase 4 — Handover", status: "Not Started", tasks: { total: 3, done: 0, inProgress: 0, notStarted: 3 }, pct: 0 },
    ],
    tasks: [
      { id: "t1", title: "Project & Task Management", status: "Done", phaseNo: 3, assignees: [{ name: "Nadia", avatar: null }] },
      { id: "t2", title: "Client Delivery Tracker", status: "Done", phaseNo: 3, assignees: [{ name: "Nadia", avatar: null }] },
      { id: "t3", title: "Approval & QC Tracker", status: "Done", phaseNo: 3, assignees: [{ name: "Nadia", avatar: null }] },
      { id: "t4", title: "SOP & Process Library", status: "Done", phaseNo: 3, assignees: [{ name: "Nadia", avatar: null }] },
      { id: "t5", title: "Internal Meeting Log", status: "In Progress", phaseNo: 3, assignees: [{ name: "Nadia", avatar: null }] },
      { id: "t6", title: "Resource & Capacity Planner", status: "In Progress", phaseNo: 3, assignees: [{ name: "Nadia", avatar: null }] },
      { id: "t7", title: "Handover Walkthrough", status: "Not Started", phaseNo: 4, assignees: [{ name: "Nadia", avatar: null }] },
    ],
  },
  {
    id: "proj-002",
    name: "Brandwell Studio — Revenue OS Build",
    client: "Brandwell Studio",
    status: "In Progress",
    phase: "Phase 2 — Revenue OS",
    progress: 40,
    startDate: "2026-03-10",
    targetDate: "2026-05-01",
    osScope: "Revenue OS",
    phases: [
      { no: 1, name: "Phase 1 — Base OS", status: "Done", tasks: { total: 5, done: 5, inProgress: 0, notStarted: 0 }, pct: 100 },
      { no: 2, name: "Phase 2 — Revenue OS", status: "In Progress", tasks: { total: 8, done: 3, inProgress: 2, notStarted: 3 }, pct: 38 },
      { no: 3, name: "Phase 3 — Handover", status: "Not Started", tasks: { total: 3, done: 0, inProgress: 0, notStarted: 3 }, pct: 0 },
    ],
    tasks: [
      { id: "t8", title: "CRM & Pipeline Setup", status: "Done", phaseNo: 2, assignees: [{ name: "Nadia", avatar: null }] },
      { id: "t9", title: "Product Catalogue", status: "Done", phaseNo: 2, assignees: [{ name: "Nadia", avatar: null }] },
      { id: "t10", title: "Billing & Payment Tracker", status: "Done", phaseNo: 2, assignees: [{ name: "Nadia", avatar: null }] },
      { id: "t11", title: "Retainer Management", status: "In Progress", phaseNo: 2, assignees: [{ name: "Nadia", avatar: null }] },
      { id: "t12", title: "Meetings & Calls Log", status: "In Progress", phaseNo: 2, assignees: [{ name: "Nadia", avatar: null }] },
    ],
  },
  {
    id: "proj-003",
    name: "Motion Creative — Operations OS Build",
    client: "Motion Creative",
    status: "In Progress",
    phase: "Phase 2 — Operations OS",
    progress: 55,
    startDate: "2026-03-20",
    targetDate: "2026-04-30",
    osScope: "Operations OS",
    phases: [
      { no: 1, name: "Phase 1 — Base OS", status: "Done", tasks: { total: 5, done: 5, inProgress: 0, notStarted: 0 }, pct: 100 },
      { no: 2, name: "Phase 2 — Operations OS", status: "In Progress", tasks: { total: 8, done: 4, inProgress: 2, notStarted: 2 }, pct: 50 },
    ],
    tasks: [
      { id: "t13", title: "Project & Task Management", status: "Done", phaseNo: 2, assignees: [{ name: "Nadia", avatar: null }] },
      { id: "t14", title: "Client Delivery Tracker", status: "Done", phaseNo: 2, assignees: [{ name: "Nadia", avatar: null }] },
      { id: "t15", title: "Team Responsibility Matrix", status: "In Progress", phaseNo: 2, assignees: [{ name: "Nadia", avatar: null }] },
    ],
  },
  {
    id: "proj-004",
    name: "Pulse Agency — Business OS Build",
    client: "Pulse Agency",
    status: "Not Started",
    phase: "Awaiting Kickoff",
    progress: 0,
    startDate: "2026-05-01",
    targetDate: "2026-07-15",
    osScope: "Business OS",
    phases: [
      { no: 1, name: "Phase 1 — Base OS", status: "Not Started", tasks: { total: 5, done: 0, inProgress: 0, notStarted: 5 }, pct: 0 },
      { no: 2, name: "Phase 2 — Revenue OS", status: "Not Started", tasks: { total: 8, done: 0, inProgress: 0, notStarted: 8 }, pct: 0 },
      { no: 3, name: "Phase 3 — Operations OS", status: "Not Started", tasks: { total: 8, done: 0, inProgress: 0, notStarted: 8 }, pct: 0 },
    ],
    tasks: [],
  },
]

const DEMO_PROJECTS_COMPLETED = [
  { id: "proj-c1", name: "Studio Republic — Revenue OS Build", client: "Studio Republic", status: "Completed", phase: "Delivered", progress: 100, startDate: "2025-12-01", targetDate: "2026-02-01", osScope: "Revenue OS", phases: [], tasks: [] },
  { id: "proj-c2", name: "Collective KL — Business OS Build", client: "Collective KL", status: "Completed", phase: "Delivered", progress: 100, startDate: "2025-11-01", targetDate: "2026-01-15", osScope: "Business OS", phases: [], tasks: [] },
  { id: "proj-c3", name: "The Content Co — Revenue OS Build", client: "The Content Co", status: "Completed", phase: "Delivered", progress: 100, startDate: "2026-01-10", targetDate: "2026-03-10", osScope: "Revenue OS", phases: [], tasks: [] },
]

export const PROJECTS = {
  counts: { total: 7, active: 4, completed: 3, "In Progress": 3, "Not Started": 1, Done: 3, Blocked: 0 },
  overview: { totalTasks: 78, doneTasks: 49, inProgressTasks: 14, blockedTasks: 0, notStartedTasks: 15, completionRate: 63 },
  builds: DEMO_PROJECTS_ACTIVE,
  completed: DEMO_PROJECTS_COMPLETED,
}

export const PROJECTS_GANTT = {
  gantt: DEMO_PROJECTS_ACTIVE.map(p => ({
    id: p.id,
    name: p.name,
    client: p.client,
    startDate: p.startDate,
    targetDate: p.targetDate,
    phases: p.phases,
    tasks: p.tasks.map(t => ({
      ...t,
      dueDate: p.targetDate,
      startDate: p.startDate,
    })),
  })),
}

export const PROJECTS_TEAM = {
  team: [
    { name: "Nadia", avatar: null, assigned: 42, done: 28, inProgress: 8, blocked: 0, notStarted: 6, completionRate: 67, avgDurationDays: 4.2 },
    { name: "Kai", avatar: null, assigned: 18, done: 15, inProgress: 2, blocked: 0, notStarted: 1, completionRate: 83, avgDurationDays: 2.1 },
  ],
  totalTasks: 60,
}

// ── /api/data/meetings ───────────────────────────────────────────────────────
export const MEETINGS = {
  meetings: [
    { date: "22 Apr", time: "10:00 AM", client: "Pulse Agency", project: "", type: "Discovery Call", today: false },
    { date: "23 Apr", time: "02:00 PM", client: "The Creative Lab", project: "", type: "Discovery Call", today: false },
    { date: "24 Apr", time: "11:00 AM", client: "Creaitors Official", project: "Business OS Build", type: "Check-in", today: false },
    { date: "25 Apr", time: "03:00 PM", client: "Forge Media", project: "", type: "Discovery Call", today: false },
    { date: "28 Apr", time: "10:00 AM", client: "Brandwell Studio", project: "Revenue OS Build", type: "Check-in", today: false },
  ],
  stats: { week: 3, month: 8, discovery: 5, followup: 2 },
}

// ── /api/data/progress (single project) ─────────────────────────────────────
export const PROGRESS = {
  project: {
    id: "proj-001",
    name: "Creaitors Official — Business OS Build",
    status: "In Progress",
    package: "Business OS",
    currentPhase: "Phase 3 — Operations OS",
    startDate: "2026-02-01",
    targetDate: "2026-05-15",
  },
  phases: [
    { no: 1, name: "Phase 1 — Base OS", status: "Done", startDate: "2026-02-01", dueDate: "2026-02-14", completedDate: "2026-02-13", tasks: { total: 5, done: 5, inProgress: 0, notStarted: 0 }, pct: 100 },
    { no: 2, name: "Phase 2 — Revenue OS", status: "Done", startDate: "2026-02-15", dueDate: "2026-03-15", completedDate: "2026-03-14", tasks: { total: 8, done: 8, inProgress: 0, notStarted: 0 }, pct: 100 },
    { no: 3, name: "Phase 3 — Operations OS", status: "In Progress", startDate: "2026-03-16", dueDate: "2026-05-15", completedDate: null, tasks: { total: 8, done: 4, inProgress: 2, notStarted: 2 }, pct: 50 },
    { no: 4, name: "Phase 4 — Handover", status: "Not Started", startDate: null, dueDate: "2026-05-15", completedDate: null, tasks: { total: 3, done: 0, inProgress: 0, notStarted: 3 }, pct: 0 },
  ],
  activeTasks: [
    { id: "t5", title: "Internal Meeting Log", status: "In Progress", dueDate: "2026-04-25", phaseNo: 3, assignees: [{ name: "Nadia", avatar: null }] },
    { id: "t6", title: "Resource & Capacity Planner", status: "In Progress", dueDate: "2026-04-28", phaseNo: 3, assignees: [{ name: "Nadia", avatar: null }] },
  ],
  upcomingTasks: [
    { id: "t7", title: "Handover Walkthrough", status: "Not Started", dueDate: "2026-05-12", phaseNo: 4, assignees: [{ name: "Nadia", avatar: null }] },
  ],
  overall: { total: 24, done: 17, inProgress: 2, pct: 65 },
}

// ── /api/client/info ─────────────────────────────────────────────────────────
export const CLIENT_INFO = {
  client: "Demo",
  slug: "demo",
  osType: ["revenue", "operations", "marketing", "finance"],
}
