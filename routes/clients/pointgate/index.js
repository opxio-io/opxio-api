// routes/clients/pointgate/index.js
import { Router } from 'express'
import { handler as statementHandler } from '../../../handlers/clients/pointgate/statement.js'

const router = Router()

// POST /api/clients/pointgate/statement
// Triggered by Notion button automation with the Tenant page_id.
// Responds 200 immediately, generates PDF in background, writes URL back to Notion.
router.post('/statement', statementHandler)
router.get('/statement',  statementHandler)  // GET for manual testing

router.get('/', (_req, res) => res.json({ ok: true, client: 'pointgate' }))

export default router
