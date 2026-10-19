import { Router } from 'express';

import {
  createCostCenter,
  createCostEntry,
  getDistributionPlan,
  getFinancialOperationsOverview,
  listCostCenters,
  listCostEntries,
  listDistributionPlans,
  refreshEurBrlFxRate,
  updateCostEntryStatus,
} from '../controllers/financial-operations.controller';

const router = Router();

router.get('/overview', getFinancialOperationsOverview);
router.get('/cost-centers', listCostCenters);
router.post('/cost-centers', createCostCenter);
router.get('/costs', listCostEntries);
router.post('/costs', createCostEntry);
router.patch('/costs/:id/status', updateCostEntryStatus);
router.get('/distribution-plans', listDistributionPlans);
router.get('/distribution-plans/:id', getDistributionPlan);
router.post('/fx/eur-brl/refresh', refreshEurBrlFxRate);

export default router;
