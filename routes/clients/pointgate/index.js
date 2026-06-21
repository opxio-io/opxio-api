// routes/clients/pointgate/index.js
import { Router } from 'express'
import { handler as statementHandler }  from '../../../handlers/clients/pointgate/statement.js'
import { handler as dashboardHandler }  from '../../../handlers/clients/pointgate/dashboard.js'
import { handler as paymentHandler }    from '../../../handlers/clients/pointgate/payment.js'
import { handler as receiptHandler }    from '../../../handlers/clients/pointgate/receipt.js'
import { handler as invoiceHandler }    from '../../../handlers/clients/pointgate/invoice.js'

const router = Router()

router.post('/statement', statementHandler)
router.get('/statement',  statementHandler)
router.get('/dashboard',  dashboardHandler)
router.patch('/payment',  paymentHandler)
router.post('/payment',   paymentHandler)
router.post('/receipt',   receiptHandler)
router.post('/invoice',   invoiceHandler)

router.get('/', (_req, res) => res.json({ ok: true, client: 'pointgate' }))

export default router

// Temporary debug endpoint
import { queryDB } from '../../../lib/notion.js'
const LEASES_DB = 'e01bc0b044b24870a4158820fe819a07'
const NOTION_KEY_FN = () => process.env.POINTGATE_NOTION_KEY || process.env.NOTION_API_KEY
router.get('/debug-leases', async (req, res) => {
  try {
    const pages = await queryDB(LEASES_DB, undefined, NOTION_KEY_FN())
    const sample = pages.slice(0, 3).map(p => ({
      title: (p.properties['Agreement Title']?.title || []).map(t => t.plain_text).join(''),
      property: (p.properties['Property']?.relation || []).map(r => r.id),
      tenant:   (p.properties['Primary Tenant']?.relation || []).map(r => r.id),
      start:    p.properties['Start Date']?.date?.start,
      end:      p.properties['End Date']?.date?.start,
    }))
    res.json({ count: pages.length, sample })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})
