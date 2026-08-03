import {
  Router
} from 'express';

import {
  createPayoutRequest,
  deletePayoutRequest,
  getPayoutFundingOptions,
  listPayoutRequests,
  requestPayoutManager,
  updatePayoutRequest
} from '../controllers/payout-requests.controller';

import {
  payoutRequestsFeatureMiddleware
} from '../middleware/payout-requests-feature.middleware';

const router =
  Router();

router.use(
  payoutRequestsFeatureMiddleware
);

router.get(
  '/funding-options',
  getPayoutFundingOptions
);

router.get(
  '/',
  listPayoutRequests
);

router.post(
  '/',
  createPayoutRequest
);

router.post(
  '/:id/request-manager',
  requestPayoutManager
);

router.patch(
  '/:id',
  updatePayoutRequest
);

router.delete(
  '/:id',
  deletePayoutRequest
);

export default router;
