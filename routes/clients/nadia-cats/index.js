import { Router } from 'express'
import { handler as dashboard } from '../../../handlers/clients/nadia-cats/dashboard.js'

const router = Router()
router.all('/dashboard', async (req, res) => { await dashboard(req, res) })

export default router
