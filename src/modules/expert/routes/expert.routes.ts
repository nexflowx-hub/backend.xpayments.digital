import { Router } from 'express';
import { createMerchantOrder, listMerchantOrders } from '../controllers/expert-orders.controller';

const router = Router();

router.get('/orders', listMerchantOrders);
router.post('/orders', createMerchantOrder);

export default router;
