import { Router } from 'express';
import {
  controlPlaneAuthMiddleware,
  requireControlPlanePermission
} from '../middleware/control-plane-auth.middleware';
import {
  getControlPlaneMe,
  logoutControlPlane
} from '../controllers/control-plane-auth.controller';
import {
  getControlPlaneOverview,
  listControlPlaneMerchants,
  getControlPlaneMerchant,
  listControlPlaneProviderAccounts,
  listControlPlaneExpertOrders,
  listControlPlaneAudit,
  listControlPlaneUsers
} from '../controllers/control-plane-read.controller';
import {
  listControlPlaneStoresSafe,
  listControlPlaneTransactionsSafe,
  listControlPlaneProviderConnectionsSafe,
  listControlPlaneVaultsSafe,
  listControlPlaneFeesSafe,
  listControlPlanePayoutsSafe
} from '../controllers/control-plane-filtered.controller';

const router = Router();

router.use(controlPlaneAuthMiddleware);

router.get('/me', getControlPlaneMe);
router.post('/auth/logout', logoutControlPlane);

router.get('/overview', requireControlPlanePermission('overview.read'), getControlPlaneOverview);
router.get('/merchants', requireControlPlanePermission('merchants.read'), listControlPlaneMerchants);
router.get('/merchants/:id', requireControlPlanePermission('merchants.read'), getControlPlaneMerchant);
router.get('/stores', requireControlPlanePermission('stores.read'), listControlPlaneStoresSafe);
router.get('/transactions', requireControlPlanePermission('transactions.read'), listControlPlaneTransactionsSafe);
router.get('/processing/provider-accounts', requireControlPlanePermission('processing.read'), listControlPlaneProviderAccounts);
router.get('/processing/provider-connections', requireControlPlanePermission('processing.read'), listControlPlaneProviderConnectionsSafe);
router.get('/processing/vaults', requireControlPlanePermission('processing.read'), listControlPlaneVaultsSafe);
router.get('/fees', requireControlPlanePermission('fees.read'), listControlPlaneFeesSafe);
router.get('/payouts', requireControlPlanePermission('payouts.read'), listControlPlanePayoutsSafe);
router.get('/expert/orders', requireControlPlanePermission('expert.read'), listControlPlaneExpertOrders);
router.get('/audit', requireControlPlanePermission('audit.read'), listControlPlaneAudit);
router.get('/users', requireControlPlanePermission('users.read'), listControlPlaneUsers);

export default router;
