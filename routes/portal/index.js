import { Router } from 'express'

import { handler as action } from '../../handlers/portal/_action.js'
import { handler as data   } from '../../handlers/portal/data.js'

const router = Router()

router.all('/:action', async (req, res) => { await action(req, res) })
router.all('/data', async (req, res) => { await data(req, res) })

export default router