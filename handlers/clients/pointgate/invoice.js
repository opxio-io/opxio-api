// handlers/clients/pointgate/invoice.js
// Per-payment invoice PDF generator for Pointgate Properties
// POST /api/clients/pointgate/invoice
// Body: { pageId, lot, tenant, month, bf, amtDue, amtPaid, status, method, payDate, dueDate }
// Returns: { url, invNum }

import PDFDocument from 'pdfkit'
import { uploadBlob } from '../../../lib/blob.js'

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

// ── PDF builder ────────────────────────────────────────────────────────────
export async function handler(req, res) {
  try {
    const {
      pageId, lot = '—', tenant = '—', month = '',
      bf = 0, amtDue = 0, amtPaid = 0, status = '—',
      method = '—', payDate = null, dueDate = null,
    } = req.body || {}

    if (!pageId) return res.status(400).json({ error: 'Missing pageId' })

    const totalOwed = (bf || 0) + (amtDue || 0)
    const balance   = totalOwed - (amtPaid || 0)

    // Invoice number
    const lotSafe   = (lot || 'XX').replace(/[^A-Z0-9]/gi, '').toUpperCase()
    const monthSafe = (month || '').replace('-', '')
    const invNum    = `INV-${lotSafe}-${monthSafe}`

    // ── Build PDF ──────────────────────────────────────────────────────────
    const doc = new PDFDocument({ size: 'A4', margin: 0 })
    const chunks = []
    doc.on('data', c => chunks.push(c))

    const W  = doc.page.width    // 595.28
    const M  = 50
    const CW = W - M * 2

    // HEADER BAR
    doc.rect(0, 0, W, 100).fill('#0D0D0D')
    doc.fillColor('#AAFF00').fontSize(24).font('Helvetica-Bold')
       .text('POINTGATE', M, 28, { lineBreak: false })
    doc.fillColor('#888888').fontSize(9).font('Helvetica')
       .text('PROPERTIES SDN BHD', M, 56, { lineBreak: false })
    doc.fillColor('#FFFFFF').fontSize(20).font('Helvetica-Bold')
       .text('INVOICE', 0, 30, { align: 'right', lineBreak: false, width: W - M })
    doc.fillColor('#888888').fontSize(9).font('Helvetica')
       .text(invNum, 0, 56, { align: 'right', lineBreak: false, width: W - M })

    // BILLED TO / DATES
    let y = 120
    doc.fillColor('#888888').fontSize(8).font('Helvetica').text('BILLED TO', M, y)
    doc.fillColor('#0D0D0D').fontSize(13).font('Helvetica-Bold').text(tenant, M, y + 13)
    doc.fillColor('#555555').fontSize(10).font('Helvetica').text('Lot ' + lot, M, y + 30)

    const rightX = W - M - 140
    doc.fillColor('#888888').fontSize(8).font('Helvetica')
       .text('INVOICE DATE', rightX, y, { width: 140, align: 'right' })
    doc.fillColor('#0D0D0D').fontSize(10).font('Helvetica')
       .text(new Date().toLocaleDateString('en-MY', { day:'2-digit', month:'short', year:'numeric' }),
         rightX, y + 13, { width: 140, align: 'right' })
    if (dueDate) {
      doc.fillColor('#888888').fontSize(8).font('Helvetica')
         .text('DUE DATE', rightX, y + 32, { width: 140, align: 'right' })
      doc.fillColor('#0D0D0D').fontSize(10).font('Helvetica')
         .text(fmtDate(dueDate), rightX, y + 45, { width: 140, align: 'right' })
    }

    // RENTAL PERIOD BANNER
    y += 75
    doc.rect(M, y, CW, 32).fill('#F5F5F5')
    doc.rect(M, y, 4, 32).fill('#AAFF00')
    doc.fillColor('#888888').fontSize(7).font('Helvetica').text('RENTAL PERIOD', M + 12, y + 6)
    doc.fillColor('#0D0D0D').fontSize(12).font('Helvetica-Bold').text(fmtMonth(month), M + 12, y + 16)

    // Status pill
    const sBg    = status === 'Paid' ? '#E8F5E9' : status === 'Overdue' ? '#FFEBEE' : '#FFF3E0'
    const sColor = status === 'Paid' ? '#2E7D32' : status === 'Overdue' ? '#C62828' : '#E65100'
    const pW = 64, pH = 18
    doc.rect(M + CW - pW - 8, y + 7, pW, pH).fill(sBg)
    doc.fillColor(sColor).fontSize(8).font('Helvetica-Bold')
       .text(status.toUpperCase(), M + CW - pW - 8, y + 12, { width: pW, align: 'center' })

    // LINE ITEMS TABLE
    y += 48
    doc.rect(M, y, CW, 22).fill('#0D0D0D')
    doc.fillColor('#AAAAAA').fontSize(8).font('Helvetica-Bold')
       .text('DESCRIPTION', M + 10, y + 7)
       .text('AMOUNT (RM)', M + CW - 110, y + 7, { width: 100, align: 'right' })
    y += 22

    function drawRow(label, sublabel, amount, opts) {
      const bg  = (opts && opts.bg)       || '#FFFFFF'
      const ac  = (opts && opts.ac)       || '#0D0D0D'
      const bld = (opts && opts.bold)     || false
      const rh  = sublabel ? 34 : 26
      doc.rect(M, y, CW, rh).fill(bg)
      doc.fillColor('#444444').fontSize(9).font(bld ? 'Helvetica-Bold' : 'Helvetica')
         .text(label, M + 10, y + (sublabel ? 6 : 9))
      if (sublabel) {
        doc.fillColor('#888888').fontSize(8).font('Helvetica').text(sublabel, M + 10, y + 19)
      }
      if (amount !== null) {
        doc.fillColor(ac).fontSize(10).font(bld ? 'Helvetica-Bold' : 'Helvetica')
           .text(fmtRM(amount), M + CW - 110, y + (sublabel ? 10 : 8), { width: 100, align: 'right' })
      }
      doc.moveTo(M, y + rh).lineTo(M + CW, y + rh).strokeColor('#EEEEEE').lineWidth(0.5).stroke()
      y += rh
    }

    if (bf > 0) {
      drawRow('Balance Brought Forward (B/F)',
        'Outstanding balance from prior period', bf,
        { bg: '#FFF8F8', ac: '#C62828' })
    }
    drawRow('Monthly Rent — ' + fmtMonth(month), null, amtDue,
      { bg: bf > 0 ? '#FAFAFA' : '#FFFFFF' })

    // Total Due
    y += 4
    doc.rect(M, y, CW, 28).fill('#F0F0F0')
    doc.fillColor('#444444').fontSize(9).font('Helvetica-Bold').text('TOTAL AMOUNT DUE', M + 10, y + 9)
    doc.fillColor('#0D0D0D').fontSize(11).font('Helvetica-Bold')
       .text(fmtRM(totalOwed), M + CW - 110, y + 8, { width: 100, align: 'right' })
    y += 28

    // Amount Paid
    drawRow('Amount Paid', payDate ? 'Received ' + fmtDate(payDate) : null, amtPaid,
      { bg: '#FAFFFC', ac: '#2E7D32' })

    // Balance row
    y += 4
    const isCleared = balance <= 0
    doc.rect(M, y, CW, 36).fill(isCleared ? '#E8F5E9' : '#FFF3F3')
    doc.rect(M, y, 4, 36).fill(isCleared ? '#2E7D32' : '#C62828')
    doc.fillColor('#666666').fontSize(8).font('Helvetica').text('OUTSTANDING BALANCE', M + 12, y + 8)
    doc.fillColor(isCleared ? '#2E7D32' : '#C62828').fontSize(15).font('Helvetica-Bold')
       .text(fmtRM(balance), M + CW - 110, y + 10, { width: 100, align: 'right' })
    if (isCleared) {
      doc.fillColor('#2E7D32').fontSize(8).font('Helvetica').text('✓ Account settled', M + 12, y + 22)
    }
    y += 36

    // PAYMENT METHOD
    y += 18
    if (method && method !== '—') {
      doc.fillColor('#888888').fontSize(8).font('Helvetica').text('PAYMENT METHOD', M, y)
      doc.fillColor('#0D0D0D').fontSize(10).font('Helvetica').text(method, M, y + 12)
      y += 32
    }

    // NOTE BOX
    y += 8
    doc.rect(M, y, CW, 38).fill('#FFFDE7')
    doc.fillColor('#F57F17').fontSize(8).font('Helvetica-Bold').text('NOTE', M + 10, y + 8)
    doc.fillColor('#555555').fontSize(8).font('Helvetica')
       .text(
         'This invoice is auto-generated from Pointgate\'s property management system. ' +
         'For disputes or queries, please contact your property manager.',
         M + 10, y + 18, { width: CW - 20 }
       )

    // FOOTER
    doc.rect(0, doc.page.height - 55, W, 55).fill('#0D0D0D')
    doc.fillColor('#555555').fontSize(8).font('Helvetica')
       .text('Pointgate Properties · For enquiries, contact your property manager',
         M, doc.page.height - 43, { width: CW, align: 'center' })
    doc.fillColor('#333333').fontSize(7)
       .text('Document ref: ' + invNum + ' · Generated ' + new Date().toISOString().substring(0, 10),
         M, doc.page.height - 27, { width: CW, align: 'center' })

    doc.end()
    await new Promise(resolve => doc.on('end', resolve))

    const buf = Buffer.concat(chunks)
    const { url } = await uploadBlob(
      'pointgate/invoices/' + invNum + '_' + Date.now() + '.pdf',
      buf, 'application/pdf'
    )

    res.json({ url, invNum })
  } catch (err) {
    console.error('[pointgate:invoice] error:', err.message, err.stack)
    res.status(500).json({ error: err.message })
  }
}
