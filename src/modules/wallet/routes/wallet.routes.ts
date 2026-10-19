import { Router } from 'express';
import * as ctrl from '../controllers/wallet.controller';
import * as operations from '../controllers/wallet-operations.controller';

const router = Router();

router.get('/', (ctrl as any).getWallets);
router.get('/movements', (ctrl as any).getWalletMovements);

/* Canonical Functional V3 operation API. */
router.get('/operations', (operations as any).getOperations);
router.get('/operations/:id', (operations as any).getOperationById);
router.post('/deposits', (operations as any).postDeposit);
router.post('/transfers', (operations as any).postTransfer);
router.post('/withdrawals', (operations as any).postWithdrawal);

/* Compatibility read models used by older frontends. */
router.get('/payouts', (ctrl as any).getPayouts);
router.get('/deposits', (ctrl as any).getDeposits);
router.get('/treasury/overview', (ctrl as any).getTreasuryOverview);

export default router;
