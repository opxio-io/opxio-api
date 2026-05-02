import { Router } from 'express'

import { handler as config } from '../../../../handlers/clients/creaitors/executive/config.js'

const router = Router()

router.all('/config', async (req, res) => { await config(req, res) })

export default router