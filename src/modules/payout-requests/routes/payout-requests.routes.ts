import {
  Router
} from 'express';

import {
  createPayoutRequest,
  deletePayoutRequest,
  getPayoutFundingOptions,
  listPayoutRequests,
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

router.patch(
  '/:id',
  updatePayoutRequest
);

router.delete(
  '/:id',
  deletePayoutRequest
);

export default router;
