import { Router } from 'express'

import { handler as crm } from '../../../../handlers/clients/creaitors/revenue/crm.js'

const router = Router()

router.all('/crm', async (req, res) => { await crm(req, res) })

export default router