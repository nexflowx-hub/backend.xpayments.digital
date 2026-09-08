import { Router } from 'express';
import { createMerchantOrder, listMerchantOrders } from '../controllers/expert-orders.controller';
import { getMerchantOrderPaymentInstructions } from '../controllers/expert-payment-instructions.controller';

const router = Router();

router.get('/orders', listMerchantOrders);
router.post('/orders', createMerchantOrder);
router.get('/orders/:orderId/payment-instructions', getMerchantOrderPaymentInstructions);

export default router;
