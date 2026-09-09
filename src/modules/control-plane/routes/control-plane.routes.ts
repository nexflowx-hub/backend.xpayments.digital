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
import {
  createMerchant, updateMerchant, deleteMerchant,
  createStore, updateStore, deleteStore,
  listTiers, createTier, updateTier, deleteTier,
  createFee, updateFee, deleteFee,
  createProviderAccount, updateProviderAccount, deleteProviderAccount,
  createVault, updateVault, deleteVault,
  createConnection, updateConnection, deleteConnection,
  upsertProcessingProfile,
  createInternalUser, updateInternalUser, deleteInternalUser
} from '../controllers/control-plane-write.controller';
import {
  listSupportTickets, getSupportTicket, createSupportTicket,
  updateSupportTicket, addSupportTicketMessage, deleteSupportTicket
} from '../controllers/control-plane-support.controller';
import {
  getExpertOrderDetail, updateExpertOrder, updateExpertStep,
  createExpertAsset, deleteExpertAsset, confirmExpertPayment
} from '../controllers/control-plane-expert.controller';

const router = Router();
router.use(controlPlaneAuthMiddleware);

router.get('/me', getControlPlaneMe);
router.post('/auth/logout', logoutControlPlane);

router.get('/overview', requireControlPlanePermission('overview.read'), getControlPlaneOverview);
router.get('/merchants', requireControlPlanePermission('merchants.read'), listControlPlaneMerchants);
router.get('/merchants/:id', requireControlPlanePermission('merchants.read'), getControlPlaneMerchant);
router.post('/merchants', requireControlPlanePermission('merchants.write'), createMerchant);
router.patch('/merchants/:id', requireControlPlanePermission('merchants.write'), updateMerchant);
router.delete('/merchants/:id', requireControlPlanePermission('merchants.write'), deleteMerchant);

router.get('/stores', requireControlPlanePermission('stores.read'), listControlPlaneStoresSafe);
router.post('/stores', requireControlPlanePermission('stores.write'), createStore);
router.patch('/stores/:id', requireControlPlanePermission('stores.write'), updateStore);
router.delete('/stores/:id', requireControlPlanePermission('stores.write'), deleteStore);
router.put('/stores/:storeId/processing-profile', requireControlPlanePermission('processing.write'), upsertProcessingProfile);

router.get('/transactions', requireControlPlanePermission('transactions.read'), listControlPlaneTransactionsSafe);

router.get('/processing/provider-accounts', requireControlPlanePermission('processing.read'), listControlPlaneProviderAccounts);
router.post('/processing/provider-accounts', requireControlPlanePermission('processing.write'), createProviderAccount);
router.patch('/processing/provider-accounts/:id', requireControlPlanePermission('processing.write'), updateProviderAccount);
router.delete('/processing/provider-accounts/:id', requireControlPlanePermission('processing.write'), deleteProviderAccount);

router.get('/processing/provider-connections', requireControlPlanePermission('processing.read'), listControlPlaneProviderConnectionsSafe);
router.post('/processing/provider-connections', requireControlPlanePermission('processing.write'), createConnection);
router.patch('/processing/provider-connections/:id', requireControlPlanePermission('processing.write'), updateConnection);
router.delete('/processing/provider-connections/:id', requireControlPlanePermission('processing.write'), deleteConnection);

router.get('/processing/vaults', requireControlPlanePermission('processing.read'), listControlPlaneVaultsSafe);
router.post('/processing/vaults', requireControlPlanePermission('processing.write'), createVault);
router.patch('/processing/vaults/:id', requireControlPlanePermission('processing.write'), updateVault);
router.delete('/processing/vaults/:id', requireControlPlanePermission('processing.write'), deleteVault);

router.get('/fees', requireControlPlanePermission('fees.read'), listControlPlaneFeesSafe);
router.post('/fees', requireControlPlanePermission('fees.write'), createFee);
router.patch('/fees/:id', requireControlPlanePermission('fees.write'), updateFee);
router.delete('/fees/:id', requireControlPlanePermission('fees.write'), deleteFee);

router.get('/tiers', requireControlPlanePermission('tiers.read'), listTiers);
router.post('/tiers', requireControlPlanePermission('fees.write'), createTier);
router.patch('/tiers/:id', requireControlPlanePermission('fees.write'), updateTier);
router.delete('/tiers/:id', requireControlPlanePermission('fees.write'), deleteTier);

router.get('/payouts', requireControlPlanePermission('payouts.read'), listControlPlanePayoutsSafe);

router.get('/expert/orders', requireControlPlanePermission('expert.read'), listControlPlaneExpertOrders);
router.get('/expert/orders/:id', requireControlPlanePermission('expert.read'), getExpertOrderDetail);
router.patch('/expert/orders/:id', requireControlPlanePermission('expert.write'), updateExpertOrder);
router.post('/expert/orders/:id/confirm-payment', requireControlPlanePermission('expert.write'), confirmExpertPayment);
router.patch('/expert/orders/:id/steps/:stepCode', requireControlPlanePermission('expert.write'), updateExpertStep);
router.post('/expert/orders/:id/assets', requireControlPlanePermission('expert.write'), createExpertAsset);
router.delete('/expert/orders/:id/assets/:assetId', requireControlPlanePermission('expert.write'), deleteExpertAsset);

router.get('/tickets', requireControlPlanePermission('tickets.read'), listSupportTickets);
router.get('/tickets/:id', requireControlPlanePermission('tickets.read'), getSupportTicket);
router.post('/tickets', requireControlPlanePermission('tickets.write'), createSupportTicket);
router.patch('/tickets/:id', requireControlPlanePermission('tickets.write'), updateSupportTicket);
router.post('/tickets/:id/messages', requireControlPlanePermission('tickets.write'), addSupportTicketMessage);
router.delete('/tickets/:id', requireControlPlanePermission('tickets.write'), deleteSupportTicket);

router.get('/audit', requireControlPlanePermission('audit.read'), listControlPlaneAudit);
router.get('/users', requireControlPlanePermission('users.read'), listControlPlaneUsers);
router.post('/users', requireControlPlanePermission('users.write'), createInternalUser);
router.patch('/users/:id', requireControlPlanePermission('users.write'), updateInternalUser);
router.delete('/users/:id', requireControlPlanePermission('users.write'), deleteInternalUser);

export default router;
