import { Router } from 'express'
import { handler as dashboard } from '../../../handlers/clients/nadia-cats/dashboard.js'
import { handler as medlog }    from '../../../handlers/clients/nadia-cats/medlog.js'

const router = Router()
router.all('/dashboard',         async (req, res) => { await dashboard(req, res) })
router.all('/medlog',            async (req, res) => { await medlog(req, res) })
router.patch('/medlog/:pageId',  async (req, res) => { await medlog(req, res) })

export default router
