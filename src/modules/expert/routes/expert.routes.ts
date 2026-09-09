import { Router } from 'express';
import { createMerchantOrder, listMerchantOrders } from '../controllers/expert-orders.controller';
import { getMerchantOrderPaymentInstructions } from '../controllers/expert-payment-instructions.controller';
import { listOrderIntake, submitPaymentProof, registerOrderDocument } from '../controllers/expert-intake.controller';

const router = Router();

router.get('/orders', listMerchantOrders);
router.post('/orders', createMerchantOrder);
router.get('/orders/:orderId/payment-instructions', getMerchantOrderPaymentInstructions);
router.get('/orders/:orderId/intake', listOrderIntake);
router.post('/orders/:orderId/payment-proofs', submitPaymentProof);
router.post('/orders/:orderId/documents', registerOrderDocument);

export default router;
