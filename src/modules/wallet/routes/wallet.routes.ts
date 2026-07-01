import { Router } from 'express';
import { getDashboard, getTransactions, getWallets, depositWallet } from '../controllers/wallet.controller';
import { authenticateMerchant } from '../../../middleware/auth.middleware';

const router = Router();

// 🔴 TODAS ESTAS ROTAS ESTÃO AGORA BLINDADAS
router.use(authenticateMerchant);

// Mantemos o padrão das rotas para não quebrar o Frontend, mas o Backend ignora o :id por segurança
router.get('/merchant/:id/dashboard', getDashboard);
router.get('/merchant/:id/transactions', getTransactions);
router.get('/wallets', getWallets);
router.post('/wallets/deposit', depositWallet);

export default router;
