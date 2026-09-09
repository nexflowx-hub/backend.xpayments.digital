import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cron from 'node-cron';

import authRoutes from '../modules/auth/routes/auth.routes';
import checkoutRoutes from '../modules/checkout/routes/checkout.routes';
import paymentRoutes from '../modules/payments/routes/payments.routes';
import aiRoutes from '../modules/ai/routes/ai.routes';
import expertPublicRoutes from '../modules/expert/routes/expert-public.routes';
import controlPlanePublicRoutes from '../modules/control-plane/routes/control-plane-public.routes';
import controlPlaneRoutes from '../modules/control-plane/routes/control-plane.routes';

import analyticsRoutes from '../modules/analytics/routes/analytics.routes';
import financeRoutes from '../modules/finance/routes/finance.routes';
import payoutStatementRoutes from '../modules/payout-statements/routes/payout-statements.routes';
import walletRoutes from '../modules/wallet/routes/wallet.routes';
import transactionRoutes from '../modules/transactions/routes/transactions.routes';
import treasuryRoutes from '../modules/treasury/routes/treasury.routes';
import riskRoutes from '../modules/risk/routes/risk.routes';
import merchantRoutes from '../modules/merchant/routes/merchant.routes';
import gatewayRoutes from '../modules/gateway/routes/gateway.routes';
import commerceRoutes from '../modules/commerce/routes/commerce.routes';
import developerRoutes from '../modules/developer/routes/developer.routes';
import adminRoutes from '../modules/admin/routes/admin.routes';
import expertRoutes from '../modules/expert/routes/expert.routes';
import expertOpsRoutes from '../modules/expert-ops/routes/expert-ops.routes';

import { authMiddleware } from '../middleware/auth.middleware';
import { processSettlements } from './jobs/settlement.job';

const app = express();
const PORT = 8084;

app.set('trust proxy', 1);
app.use(helmet());

app.use(cors({
  origin(origin, callback) {
    callback(null, true);
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Authorization','Content-Type','x-api-key','Accept']
}));

app.use(express.json({ limit: '256kb' }));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

const settlementCronEnabled = String(process.env.XPAYMENTS_SETTLEMENT_CRON_ENABLED ?? 'false').trim().toLowerCase() === 'true';

if (settlementCronEnabled) {
  cron.schedule('0 0 * * *', () => {
    console.log('⏰ [CRON] Iniciando agendamento diário de liquidação...');
    processSettlements().catch(error => console.error('❌ [CRON] Falha na liquidação:', error));
  });
  console.log('✅ [CRON] Serviço de liquidação automática (D+3) iniciado.');
} else {
  console.log('⏸️ [CRON] Liquidação automática D+3 desativada. Liberações em modo manual.');
}

app.get('/api/health', (req, res) => {
  res.json({ success: true, version: '3.1.0', engine: 'XPayments', status: 'ONLINE' });
});

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/checkout', checkoutRoutes);
app.use('/api/v1/payments', paymentRoutes);
app.use('/api/v1/expert', expertPublicRoutes);
app.use('/api/v1/ai', aiRoutes);

// Dedicated internal identity plane. It deliberately does not inherit Merchant JWT auth.
app.use('/api/v1/control-plane', controlPlanePublicRoutes);
app.use('/api/v1/control-plane', controlPlaneRoutes);

const api = express.Router();
api.use(authMiddleware);

api.use('/merchant', merchantRoutes);
api.use('/gateway-vault', gatewayRoutes);
api.use('/transactions', transactionRoutes);
api.use('/wallets', walletRoutes);
api.use('/analytics', analyticsRoutes);
api.use('/finance', financeRoutes);
api.use('/payout-statements', payoutStatementRoutes);
api.use('/risk', riskRoutes);
api.use('/treasury', treasuryRoutes);
api.use('/expert', expertRoutes);
api.use('/expert-ops', expertOpsRoutes);

api.use('/', commerceRoutes);
api.use('/', developerRoutes);
api.use('/', adminRoutes);

app.use('/api/v1', api);

app.listen(PORT, () => {
  console.log(`🚀 XPayments V3.1 listening on ${PORT}`);
});
