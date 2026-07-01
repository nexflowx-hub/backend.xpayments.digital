import { Router } from 'express';
import { misticpayWebhook, stripeWebhook, simulateSuccess } from '../controllers/webhooks.controller';

const router = Router();
router.post('/misticpay', misticpayWebhook);
router.post('/stripe', stripeWebhook);
router.post('/checkout/simulate-success', simulateSuccess);
export default router;
