import { Router } from 'express'

import { handler as bottlenecks } from '../../handlers/marketing/bottlenecks.js'
import { handler as campaign_stats } from '../../handlers/marketing/campaign-stats.js'
import { handler as cascade_task_status } from '../../handlers/marketing/cascade-task-status.js'
import { handler as content_stats } from '../../handlers/marketing/content-stats.js'
import { handler as crm } from '../../handlers/marketing/crm.js'
import { handler as employee_stats } from '../../handlers/marketing/employee-stats.js'
import { handler as staff_breakdown } from '../../handlers/marketing/staff-breakdown.js'

const router = Router()

router.all('/bottlenecks', async (req, res) => { await bottlenecks(req, res) })
router.all('/campaign-stats', async (req, res) => { await campaign_stats(req, res) })
router.all('/cascade-task-status', async (req, res) => { await cascade_task_status(req, res) })
router.all('/content-stats', async (req, res) => { await content_stats(req, res) })
router.all('/crm', async (req, res) => { await crm(req, res) })
router.all('/employee-stats', async (req, res) => { await employee_stats(req, res) })
router.all('/staff-breakdown', async (req, res) => { await staff_breakdown(req, res) })

export default router