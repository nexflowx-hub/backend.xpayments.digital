import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cron from 'node-cron';

import authRoutes from '../modules/auth/routes/auth.routes';
import checkoutRoutes from '../modules/checkout/routes/checkout.routes';
import paymentRoutes from '../modules/payments/routes/payments.routes';
import aiRoutes from '../modules/ai/routes/ai.routes';

import analyticsRoutes from '../modules/analytics/routes/analytics.routes';
import walletRoutes from '../modules/wallet/routes/wallet.routes';
import transactionRoutes from '../modules/transactions/routes/transactions.routes';
import treasuryRoutes from '../modules/treasury/routes/treasury.routes';
import riskRoutes from '../modules/risk/routes/risk.routes';
import merchantRoutes from '../modules/merchant/routes/merchant.routes';
import gatewayRoutes from '../modules/gateway/routes/gateway.routes';
import commerceRoutes from '../modules/commerce/routes/commerce.routes';
import developerRoutes from '../modules/developer/routes/developer.routes';
import adminRoutes from '../modules/admin/routes/admin.routes';

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

  methods: [
    'GET',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'OPTIONS'
  ],

  allowedHeaders: [
    'Authorization',
    'Content-Type',
    'x-api-key',
    'Accept'
  ]
}));

app.use(express.json({
  limit: '256kb'
}));

app.use((req, res, next) => {
  console.log(
    `[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`
  );

  next();
});

/*
|--------------------------------------------------------------------------
| CRON JOBS
|--------------------------------------------------------------------------
*/

cron.schedule('0 0 * * *', () => {
  console.log(
    '⏰ [CRON] Iniciando agendamento diário de liquidação...'
  );

  processSettlements().catch(error =>
    console.error(
      '❌ [CRON] Falha na liquidação:',
      error
    )
  );
});

console.log(
  '✅ [CRON] Serviço de liquidação automática (D+3) iniciado.'
);

/*
|--------------------------------------------------------------------------
| PUBLIC API
|--------------------------------------------------------------------------
*/

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    version: '3.1.0',
    engine: 'XPayments',
    status: 'ONLINE'
  });
});

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/checkout', checkoutRoutes);
app.use('/api/v1/payments', paymentRoutes);

/*
|--------------------------------------------------------------------------
| XPIA PUBLIC API
|--------------------------------------------------------------------------
|
| O endpoint é público para permitir utilização na landing page /support.
| Possui validação, limites de payload e rate limit interno.
|
*/

app.use('/api/v1/ai', aiRoutes);

/*
|--------------------------------------------------------------------------
| PRIVATE API
|--------------------------------------------------------------------------
*/

const api = express.Router();

api.use(authMiddleware);

api.use('/merchant', merchantRoutes);
api.use('/gateway-vault', gatewayRoutes);
api.use('/transactions', transactionRoutes);
api.use('/wallets', walletRoutes);
api.use('/analytics', analyticsRoutes);
api.use('/risk', riskRoutes);
api.use('/treasury', treasuryRoutes);

api.use('/', commerceRoutes);
api.use('/', developerRoutes);
api.use('/', adminRoutes);

app.use('/api/v1', api);

app.listen(PORT, () => {
  console.log(
    `🚀 XPayments V3.1 listening on ${PORT}`
  );
});
