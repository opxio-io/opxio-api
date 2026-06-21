// handlers/clients/pointgate/invoice.js
// POST /api/clients/pointgate/invoice
// Body: { pageId, lot, tenant, month, bf, amtDue, amtPaid, status, method, payDate, dueDate }
// Returns: { url, invNum }

import PDFDocument from 'pdfkit'
import { hdrs, patchPage } from '../../../lib/notion.js'
import { uploadBlob } from '../../../lib/blob.js'

const NOTION_KEY  = () => process.env.POINTGATE_NOTION_KEY || process.env.NOTION_API_KEY
const PAYMENTS_DB = 'cdc0a5b7e9384afabdc83cb24004f6f8'

// ── One-time DB schema setup ───────────────────────────────────────────────
let dbSchemaReady = false
async function ensureDbSchema(token) {
  if (dbSchemaReady) return
  try {
    await fetch(`https://api.notion.com/v1/databases/${PAYMENTS_DB}`, {
      method: 'PATCH',
      headers: hdrs(token),
      body: JSON.stringify({
        properties: {
          'Invoice No':  { rich_text: {} },
          'Invoice PDF': { url: {} },
        }
      })
    })
    dbSchemaReady = true
  } catch (e) {
    console.warn('[pointgate:invoice] db schema setup:', e.message)
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────
function fmtDate(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso + 'T00:00:00').toLocaleDateString('en-MY', {
      day: '2-digit', month: 'short', year: 'numeric',
    })
  } catch { return iso }
}

function fmtRM(num) {
  if (num === null || num === undefined || isNaN(num)) return '—'
  const abs = Math.abs(num)
  const str = 'RM ' + abs.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return num < 0 ? '(' + str + ')' : str
}

function fmtMonth(ym) {
  if (!ym) return '—'
  const [y, m] = ym.split('-')
  const names = ['January','February','March','April','May','June',
                 'July','August','September','October','November','December']
  return `${names[parseInt(m, 10) - 1] || m} ${y}`
}

function priorMonth(ym) {
  if (!ym) return ''
  const [y, m] = ym.split('-').map(Number)
  if (m === 1) return `${y - 1}-12`
  return `${y}-${String(m - 1).padStart(2, '0')}`
}

// ── PDF ────────────────────────────────────────────────────────────────────
export async function handler(req, res) {
  try {
    let {
      pageId, lot = '—', tenant = '', month = '',
      bf = 0, amtDue = 0, amtPaid = 0, status = '—',
      method = '', payDate = null, dueDate = null,
    } = req.body || {}

    if (!pageId) return res.status(400).json({ error: 'Missing pageId' })

    bf      = Number(bf)      || 0
    amtDue  = Number(amtDue)  || 0
    amtPaid = Number(amtPaid) || 0

    const token      = NOTION_KEY()
    const totalOwed  = bf + amtDue
    const balance    = totalOwed - amtPaid
    const isCleared  = balance <= 0

    await ensureDbSchema(token)

    // Invoice number — deterministic per lot+month
    const lotSafe   = (lot || 'XX').replace(/[^A-Z0-9\-]/gi, '').toUpperCase()
    const monthSafe = (month || '').replace('-', '')
    const invNum    = `INV-${lotSafe}-${monthSafe}`

    const doc = new PDFDocument({ size: 'A4', margin: 0 })
    const chunks = []
    doc.on('data', c => chunks.push(c))

    const W  = doc.page.width   // 595.28
    const H  = doc.page.height  // 841.89
    const M  = 50
    const CW = W - M * 2       // 495.28

    // ── HEADER ─────────────────────────────────────────────────────────────
    doc.rect(0, 0, W, 120).fill('#111111')

    // Full company name (white, prominent)
    doc.fillColor('#FFFFFF').fontSize(20).font('Helvetica-Bold')
       .text('Pointgate Properties Sdn Bhd', M, 28, { lineBreak: false })
    doc.fillColor('#888888').fontSize(8.5).font('Helvetica')
       .text('Lot 3417-13, Jalan Merbau, Kampung Melayu Subang, 40150 Shah Alam, Selangor', M, 52, { lineBreak: false })

    // Contact top-right
    doc.fillColor('#AAAAAA').fontSize(8.5).font('Helvetica')
       .text('pgprop@pointgate.net', 0, 35, { align: 'right', lineBreak: false, width: W - M })
       .text('+60 12-457 4600', 0, 50, { align: 'right', lineBreak: false, width: W - M })

    // Lime accent bar
    doc.rect(0, 118, W, 2).fill('#AAFF00')

    // ── INVOICE BAND ───────────────────────────────────────────────────────
    doc.rect(0, 120, W, 44).fill('#1A1A1A')
    doc.fillColor('#FFFFFF').fontSize(18).font('Helvetica-Bold')
       .text('INVOICE', M, 132, { lineBreak: false })
    doc.fillColor('#777777').fontSize(9).font('Helvetica')
       .text(invNum, 0, 132, { align: 'right', lineBreak: false, width: W - M })
       .text(new Date().toLocaleDateString('en-MY', { day: '2-digit', month: 'short', year: 'numeric' }),
         0, 146, { align: 'right', lineBreak: false, width: W - M })

    // ── FROM / BILLED TO ───────────────────────────────────────────────────
    let y = 185
    const colL = M
    const colR = M + CW / 2 + 10   // ~307

    // FROM (left)
    doc.fillColor('#AAAAAA').fontSize(7.5).font('Helvetica')
       .text('FROM', colL, y, { lineBreak: false })
    doc.fillColor('#222222').fontSize(10).font('Helvetica-Bold')
       .text('Pointgate Properties Sdn Bhd', colL, y + 13, { lineBreak: false })
    doc.fillColor('#555555').fontSize(8.5).font('Helvetica')
    ;['Lot 3417-13, Jalan Merbau', 'Kampung Melayu Subang', '40150 Shah Alam, Selangor']
      .forEach((line, i) => doc.text(line, colL, y + 27 + i * 13, { lineBreak: false }))

    // BILLED TO (right)
    const tenantDisplay = (tenant && tenant !== '—') ? tenant : '—'
    doc.fillColor('#AAAAAA').fontSize(7.5).font('Helvetica')
       .text('BILLED TO', colR, y, { lineBreak: false })
    doc.fillColor('#111111').fontSize(11).font('Helvetica-Bold')
       .text(tenantDisplay, colR, y + 13, { width: CW / 2 - 20, lineBreak: false })
    doc.fillColor('#555555').fontSize(8.5).font('Helvetica')
    ;[`Lot ${lot}, Jalan Merbau`, 'Kampung Melayu Subang', '40150 Shah Alam, Selangor']
      .forEach((line, i) => doc.text(line, colR, y + 27 + i * 13, { lineBreak: false }))

    // Divider
    y += 88
    doc.moveTo(M, y).lineTo(W - M, y).strokeColor('#E0E0E0').lineWidth(0.5).stroke()
    y += 16

    // ── PERIOD / DUE / STATUS ─────────────────────────────────────────────
    doc.fillColor('#AAAAAA').fontSize(7.5).font('Helvetica').text('RENTAL PERIOD', colL, y, { lineBreak: false })
    doc.fillColor('#111111').fontSize(11).font('Helvetica-Bold').text(fmtMonth(month), colL, y + 12, { lineBreak: false })

    if (dueDate) {
      doc.fillColor('#AAAAAA').fontSize(7.5).font('Helvetica')
         .text('DUE DATE', colL + 155, y, { lineBreak: false })
      doc.fillColor('#111111').fontSize(11).font('Helvetica-Bold')
         .text(fmtDate(dueDate), colL + 155, y + 12, { lineBreak: false })
    }

    // Status pill (top right)
    const sBg    = status === 'Paid' ? '#D4EDDA' : status === 'Overdue' ? '#FADADD' : status === 'Partial' ? '#FFF3CD' : '#E2E3E5'
    const sFg    = status === 'Paid' ? '#155724' : status === 'Overdue' ? '#721C24' : status === 'Partial' ? '#856404' : '#383D41'
    doc.rect(W - M - 72, y, 72, 22).fill(sBg)
    doc.fillColor(sFg).fontSize(8.5).font('Helvetica-Bold')
       .text(status.toUpperCase(), W - M - 72, y + 7, { width: 72, align: 'center', lineBreak: false })

    // ── TABLE ─────────────────────────────────────────────────────────────
    y += 50

    // Header row
    doc.rect(M, y, CW, 24).fill('#111111')
    doc.fillColor('#CCCCCC').fontSize(8).font('Helvetica-Bold')
       .text('DESCRIPTION', M + 12, y + 8, { lineBreak: false })
       .text('AMOUNT (RM)', W - M - 110, y + 8, { width: 100, align: 'right', lineBreak: false })
    y += 24

    let alt = false
    function row(label, sub, amount, opts) {
      const bg  = opts?.bg  || (alt ? '#F7F7F7' : '#FFFFFF')
      const ac  = opts?.ac  || '#111111'
      const bld = opts?.bld || false
      const rh  = sub ? 36 : 28
      doc.rect(M, y, CW, rh).fill(bg)
      if (opts?.accent) doc.rect(M, y, 3, rh).fill(opts.accent)
      doc.fillColor('#444444').fontSize(9).font(bld ? 'Helvetica-Bold' : 'Helvetica')
         .text(label, M + 12, y + (sub ? 7 : 10), { lineBreak: false })
      if (sub) doc.fillColor('#999999').fontSize(7.5).font('Helvetica').text(sub, M + 12, y + 21, { lineBreak: false })
      if (amount !== null) {
        doc.fillColor(ac).fontSize(10).font(bld ? 'Helvetica-Bold' : 'Helvetica')
           .text(fmtRM(amount), W - M - 110, y + (sub ? 11 : 9), { width: 100, align: 'right', lineBreak: false })
      }
      doc.moveTo(M, y + rh).lineTo(W - M, y + rh).strokeColor('#EEEEEE').lineWidth(0.5).stroke()
      y += rh
      alt = !alt
    }

    if (bf > 0) {
      row('Balance Brought Forward (B/F)',
        `Outstanding as at ${fmtMonth(priorMonth(month))}`,
        bf, { bg: '#FFF8F8', ac: '#C62828', accent: '#C62828' })
    }
    row(`Monthly Rent — ${fmtMonth(month)}`, null, amtDue)

    // Total due
    y += 4
    doc.rect(M, y, CW, 30).fill('#EFEFEF')
    doc.fillColor('#333333').fontSize(9).font('Helvetica-Bold').text('TOTAL AMOUNT DUE', M + 12, y + 10, { lineBreak: false })
    doc.fillColor('#111111').fontSize(11).font('Helvetica-Bold')
       .text(fmtRM(totalOwed), W - M - 110, y + 9, { width: 100, align: 'right', lineBreak: false })
    y += 30

    alt = false
    row('Amount Paid', payDate ? `Received ${fmtDate(payDate)}` : null,
      amtPaid, { bg: '#F6FBF6', ac: '#2E7D32' })

    // Balance row
    y += 4
    const balBg = isCleared ? '#EBF5EB' : '#FEF0F0'
    const balFg = isCleared ? '#1B5E20' : '#B71C1C'
    doc.rect(M, y, CW, 40).fill(balBg)
    doc.rect(M, y, 3, 40).fill(balFg)
    doc.fillColor('#777777').fontSize(7.5).font('Helvetica').text('OUTSTANDING BALANCE', M + 12, y + 9, { lineBreak: false })
    if (isCleared) {
      doc.fillColor(balFg).fontSize(8).font('Helvetica').text('✓ Account fully settled', M + 12, y + 22, { lineBreak: false })
    }
    doc.fillColor(balFg).fontSize(16).font('Helvetica-Bold')
       .text(fmtRM(Math.abs(balance)), W - M - 110, y + 12, { width: 100, align: 'right', lineBreak: false })
    y += 40

    // ── PAYMENT METHOD ─────────────────────────────────────────────────────
    if (method && method !== '—') {
      y += 18
      doc.fillColor('#AAAAAA').fontSize(7.5).font('Helvetica').text('PAYMENT METHOD', M, y, { lineBreak: false })
      doc.fillColor('#333333').fontSize(10).font('Helvetica').text(method, M, y + 12, { lineBreak: false })
      y += 32
    }

    // ── NOTE ───────────────────────────────────────────────────────────────
    y += 10
    doc.rect(M, y, CW, 38).fill('#FFFDF0')
    doc.fillColor('#8A6D00').fontSize(7.5).font('Helvetica-Bold').text('NOTE', M + 10, y + 8, { lineBreak: false })
    doc.fillColor('#666666').fontSize(8).font('Helvetica')
       .text('This document is auto-generated from Pointgate\'s property management system. ' +
             'For disputes or enquiries, contact pgprop@pointgate.net or +60 12-457 4600.',
         M + 10, y + 19, { width: CW - 20 })

    // ── FOOTER ─────────────────────────────────────────────────────────────
    doc.rect(0, H - 52, W, 52).fill('#111111')
    doc.rect(0, H - 52, W, 2).fill('#AAFF00')
    doc.fillColor('#777777').fontSize(8).font('Helvetica')
       .text('Pointgate Properties Sdn Bhd  ·  Lot 3417-13, Jalan Merbau, Kampung Melayu Subang, 40150 Shah Alam, Selangor',
         M, H - 40, { width: CW, align: 'center', lineBreak: false })
    doc.fillColor('#555555').fontSize(7.5)
       .text(`${invNum}  ·  Generated ${new Date().toISOString().substring(0, 10)}`,
         M, H - 25, { width: CW, align: 'center', lineBreak: false })

    doc.end()
    await new Promise(resolve => doc.on('end', resolve))

    const buf = Buffer.concat(chunks)
    const { url } = await uploadBlob(
      `pointgate/invoices/${invNum}_${Date.now()}.pdf`, buf, 'application/pdf'
    )

    // Write back to Notion (fire-and-forget)
    const normalId = pageId.replace(/-/g, '').replace(
      /^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'
    )
    patchPage(normalId, {
      'Invoice No':  { rich_text: [{ text: { content: invNum } }] },
      'Invoice PDF': { url },
    }, token).catch(e => console.warn('[pointgate:invoice] notion write-back:', e.message))

    res.json({ url, invNum })
  } catch (err) {
    console.error('[pointgate:invoice] error:', err.message, err.stack)
    res.status(500).json({ error: err.message })
  }
}
