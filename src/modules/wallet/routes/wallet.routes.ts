import { Router } from 'express';
import * as ctrl from '../controllers/wallet.controller';
const router = Router();
router.get('/', (ctrl as any).getWallets);
router.get('/movements', (ctrl as any).getWalletMovements);
router.get('/payouts', (ctrl as any).getPayouts);
router.get('/deposits', (ctrl as any).getDeposits);
router.get('/treasury/overview', (ctrl as any).getTreasuryOverview);
export default router;
