import { Router } from 'express';

import {
  getFinanceOverview,
  getFinanceStores
} from '../controllers/finance.controller';
import {
  getProviderFinanceReleases
} from '../controllers/finance-releases.controller';

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
  getProviderFinanceReleases
);

export default router;
