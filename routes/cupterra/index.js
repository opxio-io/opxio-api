import { Router } from 'express'

import { handler as enquiry_stats } from '../../handlers/cupterra/enquiry-stats.js'

const router = Router()

router.all('/enquiry-stats', async (req, res) => { await enquiry_stats(req, res) })

export default router