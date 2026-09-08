import { Router } from 'express';
import {
  getOpsProfile,
  listOpsOrders,
  getOpsOrder,
  confirmOpsPayment,
  updateOpsStep,
  updateOpsOrder,
  createOpsAsset,
  listOpsAudit
} from '../controllers/expert-ops.controller';

const router = Router();

router.get('/me', getOpsProfile);
router.get('/orders', listOpsOrders);
router.get('/orders/:orderId', getOpsOrder);
router.patch('/orders/:orderId', updateOpsOrder);
router.post('/orders/:orderId/confirm-payment', confirmOpsPayment);
router.patch('/orders/:orderId/steps/:stepCode', updateOpsStep);
router.post('/orders/:orderId/assets', createOpsAsset);
router.get('/audit', listOpsAudit);

export default router;
