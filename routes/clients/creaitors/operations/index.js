import { Router } from 'express'

import { handler as bottlenecks } from '../../../../handlers/clients/creaitors/operations/bottlenecks.js'

const router = Router()

router.all('/bottlenecks', async (req, res) => { await bottlenecks(req, res) })

export default router