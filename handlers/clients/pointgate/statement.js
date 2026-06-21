// handlers/clients/pointgate/statement.js
// Statement of Account PDF generator for Pointgate Properties
// Triggered by Notion automation: POST /api/clients/pointgate/statement
// Body: { page_id: "<notion_tenant_page_id>" }

import PDFDocument from 'pdfkit'
import { getPage, queryDB, plain, patchPage } from '../../../lib/notion.js'
import { uploadBlob } from '../../../lib/blob.js'

const waitUntil = (p) => Promise.resolve(p).catch(console.error)

// ── Pointgate Notion DB IDs ───────────────────────────────────────────────
const PG = {
  TENANTS:    '11bc170f3fc643b2b0e12ef9ef712300',
  PROPERTIES: '979e0918c8db459694657c30743c4846',
  PAYMENTS:   'cdc0a5b7e9384afabdc83cb24004f6f8',
  LEASES:     '96b16ae253b54ec4be7ccbc725357b20',
}

// ── Format helpers ─────────────────────────────────────────────────────────
function fmtDate(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString('en-MY', {
      day: '2-digit', month: 'short', year: 'numeric',
    })
  } catch { return iso }
}

function fmtRM(num) {
  if (num == null) return '—'
  return `RM ${Number(num).toLocaleString('en-MY', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function trunc(str, max) {
  if (!str) return ''
  return str.length > max ? str.slice(0, max - 1) + '…' : str
}

// ── Notion data fetching ───────────────────────────────────────────────────
async function getTenant(pageId) {
  const token = process.env.NOTION_API_KEY
  const page  = await getPage(pageId, token)
  const p     = page.properties
  return {
    fullName:    plain(p['Full Name']?.title || []),
    status:      p['Status']?.select?.name || '',
    phone:       p['Phone']?.phone_number || '',
    email:       p['Email']?.email || '',
    propertyIds: (p['Property']?.relation || []).map(r => r.id.replace(/-/g, '')),
  }
}

async function getPropertyName(propertyId) {
  try {
    const token = process.env.NOTION_API_KEY
    const page  = await getPage(propertyId, token)
    return plain(page.properties['Property Name']?.title || []) || propertyId
  } catch { return propertyId }
}

async function getPaymentsForProperty(propertyId) {
  const token = process.env.NOTION_API_KEY
  return queryDB(PG.PAYMENTS, {
    property: 'Property',
    relation: { contains: propertyId },
  }, token)
}

async function getLeasesForTenant(tenantName) {
  const token = process.env.NOTION_API_KEY
  try {
    return await queryDB(PG.LEASES, {
      property:  'Additional Tenants',
      rich_text: { contains: tenantName },
    }, token)
  } catch (e) {
    console.warn('[pointgate:soa] lease lookup failed:', e.message)
    return []
  }
}

// ── PDF generation ─────────────────────────────────────────────────────────
function buildSOAPdf({ tenantName, propertyNames, phone, email, status, payments, leases, generatedDate }) {
  return new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ size: 'A4', margin: 50 })
    const chunks = []
    doc.on('data',  c => chunks.push(c))
    doc.on('end',   () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    const PAGE_W = doc.page.width    // 595.28
    const MARGIN = 50
    const COL_W  = PAGE_W - MARGIN * 2  // 495.28
    const BLACK  = '#111111'
    const WHITE  = '#FFFFFF'
    const LIME   = '#AAFF00'
    const GREY   = '#777777'
    const LINE   = '#DDDDDD'
    const RED    = '#C62828'
    const GREEN  = '#2E7D32'

    // ── Header ────────────────────────────────────────────────────────────
    doc.rect(0, 0, PAGE_W, 82).fill(BLACK)
    doc.fillColor(LIME).font('Helvetica-Bold').fontSize(20)
       .text('POINTGATE', MARGIN, 20, { lineBreak: false })
    doc.fillColor(WHITE).font('Helvetica').fontSize(8)
       .text('PROPERTIES SDN BHD', MARGIN, 45, { lineBreak: false })
    doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(11)
       .text('STATEMENT OF ACCOUNT', MARGIN, 20, { align: 'right', lineBreak: false })
    doc.fillColor(GREY).font('Helvetica').fontSize(8)
       .text(`Issued: ${generatedDate}`, MARGIN, 38, { align: 'right', lineBreak: false })
    doc.y = 97

    // ── Tenant info ───────────────────────────────────────────────────────
    doc.rect(MARGIN, doc.y, COL_W, 1).fill(LINE)
    doc.y += 9
    doc.fillColor(GREY).font('Helvetica').fontSize(7)
       .text('PREPARED FOR', MARGIN, doc.y, { lineBreak: false })
    doc.y += 11
    doc.fillColor(BLACK).font('Helvetica-Bold').fontSize(11).text(tenantName, MARGIN)
    doc.font('Helvetica').fontSize(8.5).fillColor(GREY)
    if (propertyNames.length) doc.text(`Unit: ${propertyNames.join(', ')}`)
    if (phone)  doc.text(`Phone: ${phone}`)
    if (email)  doc.text(`Email: ${email}`)
    if (status) doc.text(`Status: ${status}`)

    // ── Lease info ────────────────────────────────────────────────────────
    if (leases.length) {
      const ls    = leases[0].properties
      const start = ls['Start Date']?.date?.start
      const end   = ls['End Date']?.date?.start
      const rent  = ls['Monthly Rent Agreed (RM)']?.number
      doc.y += 3
      doc.fillColor(GREY).fontSize(8)
         .text(`Lease Period: ${fmtDate(start)} – ${end ? fmtDate(end) : 'Active'}     Monthly Rent: ${fmtRM(rent)}`)
    }

    doc.y += 12
    doc.rect(MARGIN, doc.y, COL_W, 1).fill(LINE)
    doc.y += 12

    // ── Table columns ─────────────────────────────────────────────────────
    const COLS = [
      { x: MARGIN,       w: 22,  label: '#',        align: 'right'  },
      { x: MARGIN + 22,  w: 60,  label: 'Period',   align: 'left'   },
      { x: MARGIN + 82,  w: 65,  label: 'Due Date', align: 'left'   },
      { x: MARGIN + 147, w: 74,  label: 'Amt Due',  align: 'right'  },
      { x: MARGIN + 221, w: 74,  label: 'Amt Paid', align: 'right'  },
      { x: MARGIN + 295, w: 62,  label: 'Paid On',  align: 'left'   },
      { x: MARGIN + 357, w: 60,  label: 'Method',   align: 'left'   },
      { x: MARGIN + 417, w: 78,  label: 'Status',   align: 'center' },
    ]
    const ROW_H    = 14
    const HEADER_H = 16

    const paintHeader = (y) => {
      doc.rect(MARGIN, y, COL_W, HEADER_H).fill(BLACK)
      doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(7)
      for (const col of COLS) {
        doc.text(col.label, col.x + 2, y + 5, { width: col.w - 4, align: col.align, lineBreak: false })
      }
    }

    paintHeader(doc.y)
    doc.y += HEADER_H

    // ── Rows ──────────────────────────────────────────────────────────────
    const sorted = [...payments].sort((a, b) => {
      const da = a.properties['Due Date']?.date?.start || ''
      const db = b.properties['Due Date']?.date?.start || ''
      return da.localeCompare(db)
    })

    let totalDue  = 0
    let totalPaid = 0

    for (let i = 0; i < sorted.length; i++) {
      if (doc.y > doc.page.height - 130) {
        doc.addPage()
        doc.y = MARGIN
        paintHeader(doc.y)
        doc.y += HEADER_H
      }

      const pp      = sorted[i].properties
      const period  = pp['Payment Month']?.date?.start
      const dueDate = pp['Due Date']?.date?.start
      const payDate = pp['Payment Date']?.date?.start
      const amtDue  = pp['Amount Due (RM)']?.number  ?? 0
      const amtPaid = pp['Amount Paid (RM)']?.number ?? 0
      const method  = pp['Payment Method']?.select?.name || ''
      const sts     = pp['Status']?.select?.name || ''

      totalDue  += amtDue
      totalPaid += amtPaid

      const rowY = doc.y
      if (i % 2 === 1) doc.rect(MARGIN, rowY, COL_W, ROW_H).fill('#F5F5F5')

      const statusColor = sts === 'Paid' ? GREEN
        : sts === 'Overdue' ? RED
        : sts === 'Partial' ? '#E65100'
        : GREY

      const cells = [
        { val: String(i + 1),                    col: COLS[0], color: GREY   },
        { val: period  ? fmtDate(period)  : '—', col: COLS[1], color: BLACK  },
        { val: dueDate ? fmtDate(dueDate) : '—', col: COLS[2], color: BLACK  },
        { val: fmtRM(amtDue),                    col: COLS[3], color: BLACK  },
        { val: fmtRM(amtPaid),                   col: COLS[4], color: amtPaid >= amtDue ? GREEN : BLACK },
        { val: payDate ? fmtDate(payDate) : '—', col: COLS[5], color: GREY   },
        { val: trunc(method, 10),                col: COLS[6], color: GREY   },
        { val: sts,                              col: COLS[7], color: statusColor, bold: true },
      ]

      for (const cell of cells) {
        doc.fillColor(cell.color)
           .font(cell.bold ? 'Helvetica-Bold' : 'Helvetica')
           .fontSize(7.5)
           .text(cell.val, cell.col.x + 2, rowY + 3, {
             width: cell.col.w - 4,
             align: cell.col.align,
             lineBreak: false,
           })
      }

      doc.y = rowY + ROW_H
    }

    // ── Summary ───────────────────────────────────────────────────────────
    const outstanding = totalDue - totalPaid
    doc.y += 6
    doc.rect(MARGIN, doc.y, COL_W, 1).fill(LINE)
    doc.y += 10

    const sumX = MARGIN + COL_W - 200

    const summary = [
      { label: 'Total Billed:',  val: fmtRM(totalDue),  color: BLACK, bold: false },
      { label: 'Total Paid:',    val: fmtRM(totalPaid), color: GREEN, bold: false },
      { label: 'Outstanding:',   val: fmtRM(outstanding),
        color: outstanding > 0.005 ? RED : GREEN, bold: true },
    ]

    for (const item of summary) {
      const sy = doc.y
      if (item.bold) {
        doc.rect(sumX - 8, sy - 2, 205, 17)
           .fill(outstanding > 0.005 ? '#FFF0F0' : '#F0FFF4')
      }
      doc.fillColor(GREY).font('Helvetica').fontSize(8.5)
         .text(item.label, sumX, sy, { lineBreak: false })
      doc.fillColor(item.color).font(item.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5)
         .text(item.val, sumX, sy, { width: 200, align: 'right', lineBreak: false })
      doc.y = sy + 15
    }

    // ── Footer ────────────────────────────────────────────────────────────
    const footerY = doc.page.height - 42
    doc.rect(0, footerY, PAGE_W, 42).fill(BLACK)
    doc.fillColor(GREY).font('Helvetica').fontSize(7.5)
       .text(
         'System-generated by Pointgate Properties management system. For enquiries, contact your property manager.',
         MARGIN, footerY + 9,
         { width: COL_W, align: 'center', lineBreak: false }
       )
    doc.fillColor(LIME).font('Helvetica').fontSize(7)
       .text(
         `Generated: ${generatedDate}  ·  Powered by Pointgate HQ`,
         MARGIN, footerY + 24,
         { width: COL_W, align: 'center', lineBreak: false }
       )

    doc.end()
  })
}

// ── Main orchestrator ──────────────────────────────────────────────────────
export async function handleStatement(pageId) {
  const token = process.env.NOTION_API_KEY

  const tenant = await getTenant(pageId)
  if (!tenant.fullName) throw new Error(`Tenant page ${pageId} has no Full Name`)
  console.log(`[pointgate:soa] Generating for: ${tenant.fullName}`)

  const propertyNames = tenant.propertyIds.length
    ? await Promise.all(tenant.propertyIds.map(id => getPropertyName(id)))
    : []

  const paymentGroups = await Promise.all(
    tenant.propertyIds.map(id => getPaymentsForProperty(id))
  )
  const allPayments = paymentGroups.flat()
  console.log(`[pointgate:soa] ${allPayments.length} payments, properties: ${propertyNames.join(', ') || 'none'}`)

  const leases = await getLeasesForTenant(tenant.fullName)

  const generatedDate = new Date().toLocaleDateString('en-MY', {
    day: '2-digit', month: 'long', year: 'numeric',
  })

  const pdfBuf = await buildSOAPdf({
    tenantName:    tenant.fullName,
    propertyNames,
    phone:         tenant.phone,
    email:         tenant.email,
    status:        tenant.status,
    payments:      allPayments,
    leases,
    generatedDate,
  })

  const safeName = tenant.fullName.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40)
  const filename = `pointgate/soa/${safeName}_${Date.now()}.pdf`
  const { url }  = await uploadBlob(filename, pdfBuf)
  const pdfUrl   = `${url}?v=${Date.now()}`
  console.log(`[pointgate:soa] Uploaded: ${pdfUrl}`)

  try {
    await patchPage(pageId, { 'SOA PDF': { url: pdfUrl } }, token)
    console.log(`[pointgate:soa] Patched tenant page ${pageId}`)
  } catch (e) {
    console.warn('[pointgate:soa] patchPage non-fatal:', e.message)
  }

  return { tenant: tenant.fullName, property: propertyNames.join(', '), payments: allPayments.length, pdf_url: pdfUrl }
}

// ── Express request handler ────────────────────────────────────────────────
export function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  console.log('[pointgate:soa]', req.method, 'query:', JSON.stringify(req.query), 'body:', JSON.stringify(req.body))

  const rawId =
    req.body?.data?.id      ||
    req.body?.entity?.id    ||
    req.body?.pageId        ||
    req.body?.page_id       ||
    req.body?.data?.page_id ||
    req.body?.id            ||
    req.query.page_id       ||
    req.query.id

  if (!rawId || /\{\{/.test(String(rawId))) {
    console.log('[pointgate:soa] no valid page_id — rawId:', rawId)
    return res.status(200).json({ status: 'skipped', reason: 'no_page_id' })
  }

  const pageId = rawId.replace(/-/g, '')
  res.status(200).json({ status: 'accepted', page_id: pageId })

  waitUntil(
    handleStatement(pageId).catch(e =>
      console.error('[pointgate:soa] error:', e.message, e.stack)
    )
  )
}
