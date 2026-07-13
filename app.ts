import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import authRoutes from '../modules/auth/routes/auth.routes';
import analyticsRoutes from '../modules/analytics/routes/analytics.routes';
import riskRoutes from '../modules/risk/routes/risk.routes';
import walletRoutes from '../modules/wallet/routes/wallet.routes';
import commerceRoutes from '../modules/commerce/routes/commerce.routes';
import developerRoutes from '../modules/developer/routes/developer.routes';
import adminRoutes from '../modules/admin/routes/admin.routes';
import treasuryRoutes from '../modules/treasury/routes/treasury.routes';
import { authMiddleware } from '../middleware/auth.middleware';

const app = express();
const PORT = 8084;

app.use(helmet());
app.use(cors({
  origin: '*',
  credentials: true
}));
app.use(express.json());

// DIAGNÓSTICO: Log de cada request que chega
app.use((req, res, next) => {
  console.log(`[REQUEST] ${req.method} ${req.url}`);
  next();
});

// Rotas Públicas
app.use('/api/v1/auth', authRoutes);
app.get('/api/health', (req, res) => res.json({ status: 'V3_ONLINE' }));

// Rotas Privadas
const apiRouter = express.Router();
apiRouter.use(authMiddleware);

apiRouter.use('/analytics', analyticsRoutes);
apiRouter.use('/risk', riskRoutes);
apiRouter.use('/wallets', walletRoutes);
apiRouter.use('/treasury', treasuryRoutes);
apiRouter.use('/', commerceRoutes);
apiRouter.use('/', developerRoutes);
apiRouter.use('/', adminRoutes);

app.use('/api/v1', apiRouter);

app.listen(PORT, () => {
  console.log(`🚀 XPayments V3 Engine active on port ${PORT}`);
});
