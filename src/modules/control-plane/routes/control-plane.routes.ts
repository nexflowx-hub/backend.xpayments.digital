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
  listControlPlaneStores,
  listControlPlaneTransactions,
  listControlPlaneProviderAccounts,
  listControlPlaneProviderConnections,
  listControlPlaneVaults,
  listControlPlaneFees,
  listControlPlanePayouts,
  listControlPlaneExpertOrders,
  listControlPlaneAudit,
  listControlPlaneUsers
} from '../controllers/control-plane-read.controller';

const router = Router();

router.use(controlPlaneAuthMiddleware);

router.get('/me', getControlPlaneMe);
router.post('/auth/logout', logoutControlPlane);

router.get('/overview', requireControlPlanePermission('overview.read'), getControlPlaneOverview);
router.get('/merchants', requireControlPlanePermission('merchants.read'), listControlPlaneMerchants);
router.get('/merchants/:id', requireControlPlanePermission('merchants.read'), getControlPlaneMerchant);
router.get('/stores', requireControlPlanePermission('stores.read'), listControlPlaneStores);
router.get('/transactions', requireControlPlanePermission('transactions.read'), listControlPlaneTransactions);
router.get('/processing/provider-accounts', requireControlPlanePermission('processing.read'), listControlPlaneProviderAccounts);
router.get('/processing/provider-connections', requireControlPlanePermission('processing.read'), listControlPlaneProviderConnections);
router.get('/processing/vaults', requireControlPlanePermission('processing.read'), listControlPlaneVaults);
router.get('/fees', requireControlPlanePermission('fees.read'), listControlPlaneFees);
router.get('/payouts', requireControlPlanePermission('payouts.read'), listControlPlanePayouts);
router.get('/expert/orders', requireControlPlanePermission('expert.read'), listControlPlaneExpertOrders);
router.get('/audit', requireControlPlanePermission('audit.read'), listControlPlaneAudit);
router.get('/users', requireControlPlanePermission('users.read'), listControlPlaneUsers);

export default router;
