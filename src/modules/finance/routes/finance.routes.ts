import { Router } from 'express';

import {
  getFinanceOverview,
  getFinanceReleases,
  getFinanceStores
} from '../controllers/finance.controller';

const router = Router();

router.get(
  '/overview',
  getFinanceOverview
);

router.get(
  '/stores',
  getFinanceStores
);

router.get(
  '/releases',
  getFinanceReleases
);

export default router;
