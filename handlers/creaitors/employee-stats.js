// Vercel Serverless Function - Employee Stats
// Returns per-employee task data with raw task list so the widget
// can slice any week client-side without re-fetching.

import { getClientByToken, getNotionToken, resolveDB } from "../../lib/supabase.js"

function getStage(taskName) {
  const n = (taskName || '').toLowerCase();
  if (n.includes('planning'))  return 'planning';
  if (n.includes('shooting'))  return 'shooting';
  if (n.includes('editing'))   return 'editing';
  if (n.includes('posting'))   return 'posting';
  return null;
}

function extractAvatar(icon) {
  if (!icon) return null;
  if (icon.type === 'external') return icon.external?.url || null;
  if (icon.type === 'file')     return icon.file?.url || null;
  return null;
}

function normName(s) {
  return (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

export async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.query.token || req.headers['x-widget-token'];
  if (!token) return res.status(401).json({ error: 'Missing token' });
  const client = await getClientByToken(token);
  if (!client) return res.status(403).json({ error: 'Invalid token' });
  const NOTION_KEY  = getNotionToken(client);
  const TASKS_DB    = resolveDB(client, 'TASKS_DB',    '3348b289e31a80dc89e1eb7ba5b49b1a');
  const EMPLOYEE_DB = resolveDB(client, 'EMPLOYEE_DB',  'bc5b99b59468498e8a294149d6f03134');
  const LIVE_DB     = resolveDB(client, 'LIVE_DB',      '8db736ebbe3483bd84290153e8252101');
  const ISSUES_DB   = resolveDB(client, 'ISSUES_DB',    '34c736ebbe34815fb0b0d4dcef5ca373');

  try {
    const headers = {
      'Authorization': 'Bearer ' + NOTION_KEY,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    };

    // 1. Fetch all tasks (paginated)
    let allTasks = [], cursor;
    do {
      const body = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const r = await fetch('https://api.notion.com/v1/databases/' + TASKS_DB + '/query', {
        method: 'POST', headers, body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error('Tasks query failed: ' + await r.text());
      const d = await r.json();
      allTasks = allTasks.concat(d.results);
      cursor = d.has_more ? d.next_cursor : undefined;
    } while (cursor);

    // 2. Load employees from Employee Hub
    const empMap = {};
    const empIdSet = new Set();

    try {
      const empRes = await fetch('https://api.notion.com/v1/databases/' + EMPLOYEE_DB + '/query', {
        method: 'POST', headers, body: JSON.stringify({ page_size: 100 }),
      });
      if (empRes.ok) {
        const empData = await empRes.json();
        empData.results.forEach(emp => {
          const p = emp.properties;
          empIdSet.add(emp.id);
          empMap[emp.id] = {
            name:      p['Name']?.title?.map(t => t.plain_text).join('') || 'Unknown',
            role:      p['Role']?.select?.name || '',
            status:    p['Status']?.select?.name || 'Active',
            avatarUrl: extractAvatar(emp.icon),
          };
        });
      }
    } catch (_) {}

    // Collect extra employee IDs from tasks
    allTasks.forEach(task => {
      (task.properties['Assigned To']?.relation || []).forEach(r => empIdSet.add(r.id));
    });

    // 3. Fetch individual pages for employees not in Employee Hub
    await Promise.all([...empIdSet].map(async empId => {
      if (empMap[empId]) return;
      try {
        const r = await fetch('https://api.notion.com/v1/pages/' + empId, { headers });
        if (!r.ok) { empMap[empId] = { name: 'Unknown', role: '', status: 'Active', avatarUrl: null }; return; }
        const pg = await r.json();
        const p  = pg.properties;
        empMap[empId] = {
          name:      p['Name']?.title?.map(t => t.plain_text).join('') || 'Unknown',
          role:      p['Role']?.select?.name || '',
          status:    p['Status']?.select?.name || 'Active',
          avatarUrl: extractAvatar(pg.icon),
        };
      } catch { empMap[empId] = { name: 'Unknown', role: '', status: 'Active', avatarUrl: null }; }
    }));

    // 4. Fetch live sessions DB — Live Host = relation, Duration Formula = number (hours)
    const liveByEmpId = {}; // empId → [{date, mins}]
    const liveHostIds = new Set();
    try {
      let liveCursor;
      do {
        const lbody = { page_size: 100 };
        if (liveCursor) lbody.start_cursor = liveCursor;
        const lr = await fetch('https://api.notion.com/v1/databases/' + LIVE_DB + '/query', {
          method: 'POST', headers, body: JSON.stringify(lbody),
        });
        if (!lr.ok) break;
        const ld = await lr.json();
        ld.results.forEach(session => {
          const sp = session.properties;
          // Duration Formula returns hours as a number
          const durProp = sp['Duration Formula'];
          let mins = 0;
          if (durProp?.type === 'number')  mins = (durProp.number || 0) * 60;
          if (durProp?.type === 'formula') mins = (durProp.formula?.number || 0) * 60;

          const dateProp = sp['Date'] || sp['Session Date'] || sp['Live Date'];
          const rawDate = dateProp?.date?.start || session.created_time || null;
          const date = rawDate ? rawDate.slice(0, 10) : null;

          // Live Host is a relation — collect IDs, resolve via empMap later
          const hostRels = sp['Live Host']?.relation || [];
          hostRels.forEach(({ id: hostId }) => {
            liveHostIds.add(hostId);
            if (!liveByEmpId[hostId]) liveByEmpId[hostId] = [];
            liveByEmpId[hostId].push({ date, mins });
          });
        });
        liveCursor = ld.has_more ? ld.next_cursor : undefined;
      } while (liveCursor);
    } catch (_) {}

    // Ensure live host pages are loaded into empMap
    await Promise.all([...liveHostIds].map(async hostId => {
      if (empMap[hostId]) return;
      empIdSet.add(hostId);
      try {
        const r = await fetch('https://api.notion.com/v1/pages/' + hostId, { headers });
        if (!r.ok) { empMap[hostId] = { name: 'Unknown', role: '', status: 'Active', avatarUrl: null }; return; }
        const pg = await r.json();
        const p  = pg.properties;
        empMap[hostId] = {
          name:      p['Name']?.title?.map(t => t.plain_text).join('') || 'Unknown',
          role:      p['Role']?.select?.name || '',
          status:    p['Status']?.select?.name || 'Active',
          avatarUrl: extractAvatar(pg.icon),
        };
      } catch { empMap[hostId] = { name: 'Unknown', role: '', status: 'Active', avatarUrl: null }; }
    }));

    // 5. Fetch issues log — Team Member is now a select field (not relation)
    const issuesByName = {}; // normName → [{date, title, summary, actionTaken, status, stage}]
    try {
      let issueCursor;
      do {
        const ibody = { page_size: 100, sorts: [{ property: 'Date', direction: 'descending' }] };
        if (issueCursor) ibody.start_cursor = issueCursor;
        const ir = await fetch('https://api.notion.com/v1/databases/' + ISSUES_DB + '/query', {
          method: 'POST', headers, body: JSON.stringify(ibody),
        });
        if (!ir.ok) break;
        const id2 = await ir.json();
        id2.results.forEach(issue => {
          const ip = issue.properties;
          const title       = ip['Issue Title']?.title?.map(t => t.plain_text).join('') || '';
          const summary     = ip['Issue Summary']?.rich_text?.map(t => t.plain_text).join('') || '';
          const actionTaken = ip['Action Taken']?.rich_text?.map(t => t.plain_text).join('') || '';
          const status      = ip['Status']?.select?.name || 'Open';
          const stage       = ip['Stage']?.select?.name || 'General';
          const rawDate     = ip['Date']?.date?.start || issue.created_time || null;
          const date        = rawDate ? rawDate.slice(0, 10) : null;

          // Team Member is now a select field — match by name
          const memberName = ip['Team Member']?.select?.name || '';
          if (memberName) {
            const key = normName(memberName);
            if (!issuesByName[key]) issuesByName[key] = [];
            issuesByName[key].push({ date, title, summary, actionTaken, status, stage });
          }
        });
        issueCursor = id2.has_more ? id2.next_cursor : undefined;
      } while (issueCursor);
    } catch (_) {}

    // 6. Build compact task list per employee
    const empTasks = {};
    [...empIdSet].forEach(id => { empTasks[id] = []; });

    allTasks.forEach(task => {
      const tp        = task.properties;
      const status    = tp['Task Status']?.status?.name || '';
      const taskName  = tp['Task List']?.title?.map(t => t.plain_text).join('') || '';
      const doneRaw   = tp['Task Done On']?.date?.start || null;
      const mins      = tp['Accumulated Mins']?.number || 0;
      const stage     = getStage(taskName);
      if (!stage) return;
      const doneDate    = doneRaw ? doneRaw.slice(0, 10) : null;
      const createdDate = (task.created_time || '').slice(0, 10);
      const isDone      = status === 'Done';

      (tp['Assigned To']?.relation || []).forEach(({ id: empId }) => {
        if (!empTasks[empId]) return;
        empTasks[empId].push({ stage, doneDate, createdDate, mins, isDone });
      });
    });

    // 7. Compute stats
    const today = new Date(); today.setHours(0,0,0,0);
    const yr = today.getFullYear(), mo = today.getMonth();

    const monthStart = yr + '-' + String(mo+1).padStart(2,'0') + '-01';
    const lastDay    = new Date(yr, mo+1, 0).getDate();
    const monthEnd   = yr + '-' + String(mo+1).padStart(2,'0') + '-' + String(lastDay).padStart(2,'0');

    const lastMo  = mo === 0 ? 11 : mo - 1;
    const lastYr  = mo === 0 ? yr - 1 : yr;
    const prevStart = lastYr + '-' + String(lastMo+1).padStart(2,'0') + '-01';
    const prevLD    = new Date(lastYr, lastMo+1, 0).getDate();
    const prevEnd   = lastYr + '-' + String(lastMo+1).padStart(2,'0') + '-' + String(prevLD).padStart(2,'0');

    const employees = [...empIdSet].map(id => {
      const tasks = empTasks[id];
      const allStats   = { planning:0, shooting:0, editing:0, posting:0, totalMins:0 };
      const monthStats = { planning:0, shooting:0, editing:0, posting:0, mins:0 };
      let prevTotal = 0;

      tasks.forEach(t => {
        if (!t.isDone) return;
        if (allStats.hasOwnProperty(t.stage)) allStats[t.stage]++;
        allStats.totalMins += t.mins;
        if (t.doneDate && t.doneDate >= monthStart && t.doneDate <= monthEnd) {
          if (monthStats.hasOwnProperty(t.stage)) monthStats[t.stage]++;
          monthStats.mins += t.mins;
        }
        if (t.doneDate && t.doneDate >= prevStart && t.doneDate <= prevEnd) {
          prevTotal++;
        }
      });

      const empName      = empMap[id]?.name || '';
      const liveSessions = liveByEmpId[id] || [];
      const issues       = issuesByName[normName(empName)] || [];

      return {
        id,
        ...empMap[id],
        tasks,
        liveSessions,
        issues,
        allStats:   { ...allStats,   totalHrs: Math.round((allStats.totalMins/60)*10)/10 },
        monthStats: { ...monthStats, hrs: Math.round((monthStats.mins/60)*10)/10 },
        prevMonthTotal: prevTotal,
      };
    }).sort((a, b) => a.name.localeCompare(b.name));

    return res.status(200).json({
      employees,
      monthLabel:  today.toLocaleString('en', { month: 'long' }) + ' ' + today.getFullYear(),
      generatedAt: new Date().toISOString(),
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}