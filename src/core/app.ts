import express from 'express';
import cors from 'cors';

// Importação das Rotas
import authRoutes from '../modules/auth/routes/auth.routes';
import { commercePrivateRoutes, commercePublicRoutes } from '../modules/commerce/routes/commerce.routes';
import developerRoutes from '../modules/developer/routes/developer.routes';
import walletRoutes from '../modules/wallet/routes/wallet.routes';
import checkoutRoutes from '../modules/checkout/routes/checkout.routes';
import webhookRoutes from '../modules/webhooks/routes/webhooks.routes';
import customerRoutes from '../modules/customers/routes/customers.routes';
import analyticsRoutes from '../modules/analytics/routes/analytics.routes';
import riskRoutes from '../modules/risk/routes/risk.routes';
import adminRoutes from '../modules/admin/routes/admin.routes'; // 🔴 MÓDULO ADMIN

const app = express();

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'] }));
app.use(express.json());

// Roteamento API v1
app.use('/api/v1/auth', authRoutes); // Auth tem rotas de admin internas (/admin/login)
app.use('/api/v1/merchant', commercePrivateRoutes);
app.use('/api/v1/merchant', developerRoutes);
app.use('/api/v1', commercePublicRoutes);
app.use('/api/v1', walletRoutes);
app.use('/api/v1/checkout', checkoutRoutes);
app.use('/api/v1/webhooks', webhookRoutes);
app.use('/api/v1/customers', customerRoutes);
app.use('/api/v1/analytics', analyticsRoutes);
app.use('/api/v1/risk', riskRoutes);
app.use('/api/v1/admin', adminRoutes); // 🔴 ROTA ADMIN LIGADA

app.get('/api/health', (req, res) => res.json({ status: 'online', version: '2.6.0-admin-manager' }));

export default app;
