import { Router } from 'express'

import { handler as enquiry_stats } from '../../../handlers/clients/shin-supplies/enquiry-stats.js'
import { handler as crm_pipeline  } from '../../../handlers/clients/shin-supplies/crm-pipeline.js'

const router = Router()

router.all('/enquiry-stats', async (req, res) => { await enquiry_stats(req, res) })
router.all('/crm-pipeline',  async (req, res) => { await crm_pipeline(req, res) })

export default router
