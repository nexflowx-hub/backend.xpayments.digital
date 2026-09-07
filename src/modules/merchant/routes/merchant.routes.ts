import { Router } from 'express';
import * as merchant from '../controllers/merchant.controller';

const router = Router();

router.get('/profile', merchant.getProfile);

// Canonical merchant-scoped Store endpoints.
router.get('/stores', merchant.getStores);
router.post('/stores', merchant.createStore);
router.get('/stores/:id', merchant.getStore);

// Backward-compatible endpoints used by the current app.xpayments.digital client.
// The controller verifies that :merchantId matches the authenticated merchant.
router.get('/:merchantId/stores', merchant.getStores);
router.post('/:merchantId/stores', merchant.createStore);

export default router;
