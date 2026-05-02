import { Router } from 'express'

import { handler as bottlenecks } from '../../handlers/creaitors/bottlenecks.js'
import { handler as campaign_stats } from '../../handlers/creaitors/campaign-stats.js'
import { handler as config } from '../../handlers/creaitors/config.js'
import { handler as content_stats } from '../../handlers/creaitors/content-stats.js'
import { handler as crm } from '../../handlers/creaitors/crm.js'
import { handler as employee_stats } from '../../handlers/creaitors/employee-stats.js'
import { handler as kol_data } from '../../handlers/creaitors/kol-data.js'
import { handler as projects } from '../../handlers/creaitors/projects.js'
import { handler as sales } from '../../handlers/creaitors/sales.js'
import { handler as task_automation } from '../../handlers/creaitors/task-automation.js'
import { handler as workspace_auth } from '../../handlers/creaitors/workspace-auth.js'
import { handler as workspace_password } from '../../handlers/creaitors/workspace-password.js'
import { handler as workspace_self_reset } from '../../handlers/creaitors/workspace-self-reset.js'
import { handler as workspace_staff } from '../../handlers/creaitors/workspace-staff.js'

const router = Router()

router.all('/bottlenecks', async (req, res) => { await bottlenecks(req, res) })
router.all('/campaign-stats', async (req, res) => { await campaign_stats(req, res) })
router.all('/config', async (req, res) => { await config(req, res) })
router.all('/content-stats', async (req, res) => { await content_stats(req, res) })
router.all('/crm', async (req, res) => { await crm(req, res) })
router.all('/employee-stats', async (req, res) => { await employee_stats(req, res) })
router.all('/kol-data', async (req, res) => { await kol_data(req, res) })
router.all('/projects', async (req, res) => { await projects(req, res) })
router.all('/sales', async (req, res) => { await sales(req, res) })
router.all('/task-automation', async (req, res) => { await task_automation(req, res) })
router.all('/workspace-auth', async (req, res) => { await workspace_auth(req, res) })
router.all('/workspace-password', async (req, res) => { await workspace_password(req, res) })
router.all('/workspace-self-reset', async (req, res) => { await workspace_self_reset(req, res) })
router.all('/workspace-staff', async (req, res) => { await workspace_staff(req, res) })

export default router