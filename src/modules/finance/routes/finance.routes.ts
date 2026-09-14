import { Router } from 'express';

import {
  getFinanceOverview,
  getFinanceStores
} from '../controllers/finance.controller';
import { getFinanceReleasesV2 } from '../controllers/finance-releases-v2.controller';

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
  getFinanceReleasesV2
);

export default router;
