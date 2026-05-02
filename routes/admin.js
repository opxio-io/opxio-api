import { Router } from 'express'

import { handler as clients } from '../handlers/admin/clients.js'

const router = Router()

router.all('/clients', async (req, res) => { await clients(req, res) })

export default router