import { Router } from 'express';
import { getDashboard, getTransactions, getWallets, depositWallet } from '../controllers/wallet.controller';
import { authenticateMerchant } from '../../../middleware/auth.middleware';

const router = Router();

// 🔴 CORREÇÃO DO CADEADO:
// Aplicamos a segurança rota a rota. Isto impede que o middleware 
// "transborde" para o Checkout e para os Webhooks que estão abaixo no app.ts.

router.get('/merchant/:id/dashboard', authenticateMerchant, getDashboard);
router.get('/merchant/:id/transactions', authenticateMerchant, getTransactions);
router.get('/wallets', authenticateMerchant, getWallets);
router.post('/wallets/deposit', authenticateMerchant, depositWallet);

export default router;
