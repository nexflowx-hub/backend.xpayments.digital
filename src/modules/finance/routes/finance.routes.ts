import { Router } from 'express';

import {
  getFinanceDashboardV2
} from '../controllers/finance-dashboard.controller';

import {
  getFinanceOverview,
  getFinanceStores
} from '../controllers/finance.controller';
import {
  getProviderFinanceReleases
} from '../controllers/finance-releases.controller';

const router = Router();

router.get(
  '/dashboard',
  getFinanceDashboardV2
);

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
  (_req, res, next) => {
    const originalJson = res.json.bind(res);

    res.json = ((body: any) => {
      if (
        body?.success === true &&
        Array.isArray(body?.data?.items)
      ) {
        const items = body.data.items.map(
          (item: Record<string, unknown>) => {
            const {
              gross: _gross,
              providerFees: _providerFees,
              platformFees: _platformFees,
              ...merchantVisibleItem
            } = item;

            return merchantVisibleItem;
          }
        );

        return originalJson({
          ...body,
          data: {
            ...body.data,
            items
          }
        });
      }

      return originalJson(body);
    }) as typeof res.json;

    next();
  },
  getProviderFinanceReleases
);

export default router;
