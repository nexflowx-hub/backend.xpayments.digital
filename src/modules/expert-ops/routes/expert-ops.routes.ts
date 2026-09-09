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
import {
  getOpsIntake,
  reviewPaymentProof,
  reviewDocument,
  updateRequirement
} from '../controllers/expert-ops-intake.controller';

const router = Router();

router.get('/me', getOpsProfile);
router.get('/orders', listOpsOrders);
router.get('/orders/:orderId', getOpsOrder);
router.patch('/orders/:orderId', updateOpsOrder);
router.post('/orders/:orderId/confirm-payment', confirmOpsPayment);
router.patch('/orders/:orderId/steps/:stepCode', updateOpsStep);
router.post('/orders/:orderId/assets', createOpsAsset);
router.get('/orders/:orderId/intake', getOpsIntake);
router.patch('/orders/:orderId/payment-proofs/:proofId', reviewPaymentProof);
router.patch('/orders/:orderId/documents/:documentId', reviewDocument);
router.patch('/orders/:orderId/requirements/:requirementCode', updateRequirement);
router.get('/audit', listOpsAudit);

export default router;
