// handlers/clients/pointgate/invoice.js
// Per-payment invoice PDF generator for Pointgate Properties
// POST /api/clients/pointgate/invoice
// Body: { pageId, lot, tenant, month, bf, amtDue, amtPaid, status, method, payDate, dueDate }
// Returns: { url, invNum }

import PDFDocument from 'pdfkit'
import { hdrs, NOTION_VERSION, patchPage } from '../../../lib/notion.js'
import { uploadBlob } from '../../../lib/blob.js'

const NOTION_KEY = () => process.env.POINTGATE_NOTION_KEY || process.env.NOTION_API_KEY
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
    console.log('[pointgate:invoice] DB schema ready')
  } catch (e) {
    console.warn('[pointgate:invoice] db schema setup failed:', e.message)
  }
}

// ── Format helpers ─────────────────────────────────────────────────────────
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
  const formatted = 'RM ' + abs.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return num < 0 ? '(' + formatted + ')' : formatted
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

// ── PDF builder ────────────────────────────────────────────────────────────
export async function handler(req, res) {
  try {
    const {
      pageId, lot = '—', tenant = '—', month = '',
      bf = 0, amtDue = 0, amtPaid = 0, status = '—',
      method = '—', payDate = null, dueDate = null,
    } = req.body || {}

    if (!pageId) return res.status(400).json({ error: 'Missing pageId' })

    const token     = NOTION_KEY()
    const totalOwed = (bf || 0) + (amtDue || 0)
    const balance   = totalOwed - (amtPaid || 0)

    // Ensure DB has Invoice No + Invoice PDF fields
    await ensureDbSchema(token)

    // Invoice number (deterministic: lot + month)
    const lotSafe   = (lot || 'XX').replace(/[^A-Z0-9]/gi, '').toUpperCase()
    const monthSafe = (month || '').replace('-', '')
    const invNum    = `INV-${lotSafe}-${monthSafe}`

    // Tenant address
    const tenantAddr = lot && lot !== '—'
      ? [`Lot ${lot}, Jalan Merbau`, 'Kampung Melayu Subang', '40150 Shah Alam, Selangor']
      : ['Kampung Melayu Subang', '40150 Shah Alam, Selangor']

    // ── Build PDF ──────────────────────────────────────────────────────────
    const doc = new PDFDocument({ size: 'A4', margin: 0 })
    const chunks = []
    doc.on('data', c => chunks.push(c))

    const W  = doc.page.width   // 595.28
    const H  = doc.page.height  // 841.89
    const M  = 50
    const CW = W - M * 2

    // ── HEADER ─────────────────────────────────────────────────────────────
    doc.rect(0, 0, W, 110).fill('#111111')

    // Company wordmark (white)
    doc.fillColor('#FFFFFF').fontSize(22).font('Helvetica-Bold')
       .text('POINTGATE', M, 25, { lineBreak: false })
    doc.fillColor('#999999').fontSize(9).font('Helvetica')
       .text('PROPERTIES SDN BHD', M, 50, { lineBreak: false })

    // Company contact (header right, stacked)
    const co = [
      'pgprop@pointgate.net',
      '+60 12-457 4600',
    ]
    doc.fillColor('#888888').fontSize(8).font('Helvetica')
    co.forEach((line, i) => {
      doc.text(line, 0, 25 + i * 13, { align: 'right', lineBreak: false, width: W - M })
    })

    // Lime green accent bar at bottom of header
    doc.rect(0, 108, W, 2).fill('#AAFF00')

    // ── INVOICE LABEL BAND ─────────────────────────────────────────────────
    doc.rect(0, 110, W, 42).fill('#1A1A1A')
    doc.fillColor('#FFFFFF').fontSize(18).font('Helvetica-Bold')
       .text('INVOICE', M, 121, { lineBreak: false })
    doc.fillColor('#666666').fontSize(9).font('Helvetica')
       .text(invNum, 0, 124, { align: 'right', lineBreak: false, width: W - M })
    doc.fillColor('#666666').fontSize(8)
       .text(new Date().toLocaleDateString('en-MY', { day: '2-digit', month: 'short', year: 'numeric' }),
         0, 137, { align: 'right', lineBreak: false, width: W - M })

    // ── BILLED-TO / COMPANY ADDRESS BLOCK ─────────────────────────────────
    let y = 175

    // Left: FROM (company address)
    doc.fillColor('#999999').fontSize(7.5).font('Helvetica')
       .text('FROM', M, y)
    doc.fillColor('#333333').fontSize(9).font('Helvetica-Bold')
       .text('Pointgate Properties Sdn Bhd', M, y + 12)
    const fromAddr = [
      'Lot 3417-13, Jalan Merbau',
      'Kampung Melayu Subang',
      '40150 Shah Alam, Selangor',
    ]
    doc.fillColor('#555555').fontSize(8.5).font('Helvetica')
    fromAddr.forEach((line, i) => doc.text(line, M, y + 24 + i * 12))

    // Right: BILLED TO (tenant address)
    const midX = W / 2 + 10
    doc.fillColor('#999999').fontSize(7.5).font('Helvetica')
       .text('BILLED TO', midX, y)
    doc.fillColor('#111111').fontSize(11).font('Helvetica-Bold')
       .text(tenant, midX, y + 12)
    doc.fillColor('#555555').fontSize(8.5).font('Helvetica')
    tenantAddr.forEach((line, i) => doc.text(line, midX, y + 26 + i * 12))

    // Divider
    y += 85
    doc.moveTo(M, y).lineTo(W - M, y).strokeColor('#E8E8E8').lineWidth(0.5).stroke()

    // ── DETAILS ROW ────────────────────────────────────────────────────────
    y += 16

    function detail(label, value, x, dy) {
      doc.fillColor('#999999').fontSize(7.5).font('Helvetica').text(label, x, y + dy)
      doc.fillColor('#111111').fontSize(10).font('Helvetica-Bold').text(value, x, y + dy + 11)
    }

    detail('RENTAL PERIOD', fmtMonth(month), M, 0)
    if (dueDate) detail('DUE DATE', fmtDate(dueDate), M + 160, 0)

    // Status pill
    const sBg    = status === 'Paid' ? '#D4EDDA' : status === 'Overdue' ? '#FADADD' : status === 'Partial' ? '#FFF3CD' : '#E2E3E5'
    const sColor = status === 'Paid' ? '#155724' : status === 'Overdue' ? '#721C24' : status === 'Partial' ? '#856404' : '#383D41'
    const pW = 70, pH = 20
    const pX = W - M - pW, pY = y
    doc.rect(pX, pY, pW, pH).fill(sBg)
    doc.fillColor(sColor).fontSize(8).font('Helvetica-Bold')
       .text(status.toUpperCase(), pX, pY + 6, { width: pW, align: 'center' })

    // ── LINE ITEMS TABLE ───────────────────────────────────────────────────
    y += 50

    // Table header
    doc.rect(M, y, CW, 24).fill('#111111')
    doc.fillColor('#BBBBBB').fontSize(8).font('Helvetica-Bold')
       .text('DESCRIPTION', M + 12, y + 8)
       .text('AMOUNT (RM)', W - M - 112, y + 8, { width: 102, align: 'right' })
    y += 24

    let altRow = false
    function drawRow(label, sublabel, amount, opts) {
      const bg  = opts && opts.bg  ? opts.bg  : altRow ? '#F8F8F8' : '#FFFFFF'
      const ac  = opts && opts.ac  ? opts.ac  : '#111111'
      const bld = opts && opts.bld ? opts.bld : false
      const rh  = sublabel ? 36 : 28
      doc.rect(M, y, CW, rh).fill(bg)
      if (opts && opts.accent) doc.rect(M, y, 3, rh).fill(opts.accent)
      doc.fillColor('#444444').fontSize(9).font(bld ? 'Helvetica-Bold' : 'Helvetica')
         .text(label, M + 12, y + (sublabel ? 7 : 10))
      if (sublabel) {
        doc.fillColor('#999999').fontSize(7.5).font('Helvetica')
           .text(sublabel, M + 12, y + 21)
      }
      if (amount !== null) {
        doc.fillColor(ac).fontSize(10).font(bld ? 'Helvetica-Bold' : 'Helvetica')
           .text(fmtRM(amount), W - M - 112, y + (sublabel ? 11 : 9), { width: 102, align: 'right' })
      }
      doc.moveTo(M, y + rh).lineTo(W - M, y + rh).strokeColor('#EEEEEE').lineWidth(0.5).stroke()
      y += rh
      altRow = !altRow
    }

    if (bf > 0) {
      drawRow(
        'Balance Brought Forward (B/F)',
        `Outstanding as at ${fmtMonth(priorMonth(month))}`,
        bf,
        { bg: '#FFF9F9', ac: '#C62828', accent: '#C62828' }
      )
    }
    drawRow(`Monthly Rent — ${fmtMonth(month)}`, null, amtDue)

    // Subtotal separator
    y += 4
    doc.moveTo(M, y).lineTo(W - M, y).strokeColor('#DDDDDD').lineWidth(0.75).stroke()
    y += 4

    // Total due
    doc.rect(M, y, CW, 30).fill('#F2F2F2')
    doc.fillColor('#333333').fontSize(9).font('Helvetica-Bold').text('TOTAL AMOUNT DUE', M + 12, y + 10)
    doc.fillColor('#111111').fontSize(11).font('Helvetica-Bold')
       .text(fmtRM(totalOwed), W - M - 112, y + 9, { width: 102, align: 'right' })
    y += 30

    altRow = false
    drawRow(
      'Amount Paid',
      payDate ? `Received ${fmtDate(payDate)}` : null,
      amtPaid,
      { bg: '#F7FBF7', ac: '#2E7D32' }
    )

    // Outstanding balance
    y += 4
    const isCleared = balance <= 0
    const balBg     = isCleared ? '#EAF4EA' : '#FEF0F0'
    const balFg     = isCleared ? '#1B5E20' : '#B71C1C'
    doc.rect(M, y, CW, 40).fill(balBg)
    doc.rect(M, y, 3, 40).fill(balFg)
    doc.fillColor('#666666').fontSize(8).font('Helvetica').text('OUTSTANDING BALANCE', M + 12, y + 9)
    if (isCleared) {
      doc.fillColor(balFg).fontSize(8).font('Helvetica').text('✓ Account fully settled', M + 12, y + 22)
    }
    doc.fillColor(balFg).fontSize(16).font('Helvetica-Bold')
       .text(fmtRM(Math.abs(balance)), W - M - 112, y + 12, { width: 102, align: 'right' })
    y += 40

    // ── PAYMENT DETAILS ────────────────────────────────────────────────────
    y += 18
    if (method && method !== '—') {
      doc.fillColor('#999999').fontSize(7.5).font('Helvetica').text('PAYMENT METHOD', M, y)
      doc.fillColor('#333333').fontSize(10).font('Helvetica').text(method, M, y + 12)
      y += 32
    }

    // ── NOTE ───────────────────────────────────────────────────────────────
    y += 6
    doc.rect(M, y, CW, 36).fill('#FFFDF0').strokeColor('#F0E8B0').lineWidth(0.5).stroke()
    doc.fillColor('#8A6D00').fontSize(7.5).font('Helvetica-Bold').text('NOTE', M + 10, y + 7)
    doc.fillColor('#666666').fontSize(8).font('Helvetica')
       .text(
         'This document is auto-generated from Pointgate\'s property management system. ' +
         'For disputes or enquiries, contact pgprop@pointgate.net or +60 12-457 4600.',
         M + 10, y + 18, { width: CW - 20 }
       )

    // ── FOOTER ─────────────────────────────────────────────────────────────
    doc.rect(0, H - 52, W, 52).fill('#111111')
    doc.rect(0, H - 52, W, 2).fill('#AAFF00')
    doc.fillColor('#666666').fontSize(8).font('Helvetica')
       .text('Pointgate Properties Sdn Bhd  ·  Lot 3417-13, Jalan Merbau, Kampung Melayu Subang, 40150 Shah Alam, Selangor',
         M, H - 42, { width: CW, align: 'center' })
    doc.fillColor('#444444').fontSize(7.5)
       .text(`${invNum}  ·  Generated ${new Date().toISOString().substring(0, 10)}`,
         M, H - 27, { width: CW, align: 'center' })

    doc.end()
    await new Promise(resolve => doc.on('end', resolve))

    const buf = Buffer.concat(chunks)
    const { url } = await uploadBlob(
      `pointgate/invoices/${invNum}_${Date.now()}.pdf`,
      buf, 'application/pdf'
    )

    // ── Write back to Notion ───────────────────────────────────────────────
    const normalId = pageId.replace(/-/g, '').replace(
      /^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'
    )
    patchPage(normalId, {
      'Invoice No':  { rich_text: [{ text: { content: invNum } }] },
      'Invoice PDF': { url },
    }, token).catch(e => console.warn('[pointgate:invoice] notion write-back failed:', e.message))

    res.json({ url, invNum })
  } catch (err) {
    console.error('[pointgate:invoice] error:', err.message, err.stack)
    res.status(500).json({ error: err.message })
  }
}
