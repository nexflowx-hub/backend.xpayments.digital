import express from 'express';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 8084;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_xpayments_digital_2026_master_key';

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'] }));
app.use(express.json());

const getMerchantId = (req: any) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return null;
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    return decoded.id;
  } catch (e) { return null; }
};

// 1. AUTH & ADMIN
app.post('/api/v1/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const merchant = await prisma.merchant.findUnique({ where: { email } });
    if (!merchant || merchant.password !== password) return res.status(401).json({ success: false, error: 'Credenciais inválidas.' });
    if (merchant.status !== 'ACTIVE') return res.status(403).json({ success: false, error: 'Conta suspensa.' });
    const token = jwt.sign({ id: merchant.id, role: 'merchant' }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ success: true, data: { merchantId: merchant.id, name: merchant.name, tier: merchant.tier, token, role: 'merchant' } });
  } catch (error) { res.status(500).json({ success: false, error: 'Erro no login.' }); }
});

app.post('/api/v1/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const admin = await prisma.adminUser.findUnique({ where: { email } });
    if (!admin || admin.password !== password) return res.status(401).json({ success: false, error: 'Acesso Negado.' });
    const token = jwt.sign({ id: admin.id, role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ success: true, data: { adminId: admin.id, name: admin.name, role: 'admin', token } });
  } catch (error) { res.status(500).json({ success: false, error: 'Erro no login.' }); }
});

app.get('/api/v1/admin/stats', async (req, res) => {
  try {
    const totalMerchants = await prisma.merchant.count();
    const activeMerchants = await prisma.merchant.count({ where: { status: 'ACTIVE' } });
    const totalTransactions = await prisma.transaction.count();
    const volume = await prisma.transaction.aggregate({ _sum: { amountUSDT: true } });
    const pendingTickets = await prisma.supportTicket.count({ where: { status: 'OPEN' } });
    res.json({ success: true, data: { totalMerchants, activeMerchants, totalTransactions, totalVolumeUSDT: volume._sum.amountUSDT || 0, pendingTickets } });
  } catch (error) { res.status(500).json({ success: false, error: 'Erro nas estatísticas.' }); }
});

app.get('/api/v1/admin/merchants', async (req, res) => {
  try {
    const merchants = await prisma.merchant.findMany({ include: { _count: { select: { stores: true } } }, orderBy: { createdAt: 'desc' } });
    const formatted = await Promise.all(merchants.map(async (m) => {
      const vol = await prisma.transaction.aggregate({ where: { merchantId: m.id }, _sum: { amountUSDT: true } });
      return { id: m.id, name: m.name, email: m.email, tier: m.tier, status: m.status, activeStores: m._count.stores, totalVolume: vol._sum.amountUSDT || 0 };
    }));
    res.json({ success: true, data: formatted });
  } catch (error) { res.status(500).json({ success: false, error: 'Erro ao listar lojistas.' }); }
});

// 2. MERCHANT DASHBOARD & STORES
app.get('/api/v1/merchant/:id/dashboard', async (req, res) => {
  try {
    const ledgers = await prisma.ledger.groupBy({ by: ['status'], where: { merchantId: req.params.id }, _sum: { amountUSDT: true } });
    const balances = { incoming: 0, pending: 0, reserve: 0, available: 0 };
    ledgers.forEach(l => { const key = l.status.toLowerCase(); if (key in balances) (balances as any)[key] = Number(l._sum.amountUSDT) || 0; });
    res.json({ success: true, data: { balances } });
  } catch (error) { res.status(500).json({ success: false, error: 'Erro nos saldos.' }); }
});

app.get('/api/v1/merchant/:id/transactions', async (req, res) => {
  try {
    const txs = await prisma.transaction.findMany({ where: { merchantId: req.params.id }, orderBy: { createdAt: 'desc' }, take: 10, include: { store: { select: { name: true } } } });
    const formatted = txs.map(tx => ({ id: tx.id, amount: Number(tx.amountUSDT), fiatAmount: Number(tx.amountFiat), fiatCurrency: tx.currency, status: tx.status, createdAt: tx.createdAt, store: tx.store }));
    res.json({ success: true, data: formatted });
  } catch (error) { res.status(500).json({ success: false, error: 'Erro nas transações.' }); }
});

app.get('/api/v1/merchant/:id/stores', async (req, res) => {
  try {
    const stores = await prisma.store.findMany({ where: { merchantId: req.params.id }, orderBy: { createdAt: 'desc' } });
    res.json({ success: true, data: stores });
  } catch (error) { res.status(500).json({ success: false, error: 'Erro ao listar checkouts.' }); }
});

app.post('/api/v1/merchant/:id/stores', async (req, res) => {
  try {
    const { name, primaryColor, successUrl, webhookUrl } = req.body;
    const newStore = await prisma.store.create({
      data: { merchantId: req.params.id, name: name || 'Novo Checkout', primaryColor: primaryColor || '#10b981', successUrl: successUrl || '', webhookUrl: webhookUrl || '', checkoutConfig: { allowedMethods: ["CARD", "MBWAY"], defaultCurrency: "EUR" } }
    });
    res.json({ success: true, data: newStore });
  } catch (error) { res.status(500).json({ success: false, error: 'Erro ao criar checkout.' }); }
});

// 3. API KEYS & SECURITY (Agora retorna PK e SK, e permite DELETAR)
app.get('/api/v1/merchant/api-keys', async (req, res) => {
  try {
    const merchantId = getMerchantId(req);
    if (!merchantId) return res.status(401).json({ success: false, error: 'Não autorizado' });
    
    const keys = await prisma.apiKey.findMany({ where: { merchantId }, orderBy: { createdAt: 'desc' } });
    // Enviamos a publicKey e a secretKey para o frontend poder gerir o "olho"
    const formattedKeys = keys.map(k => ({ id: k.id, name: k.merchantName, publicKey: k.publicKey, secretKey: k.secretKey, isActive: k.isActive, createdAt: k.createdAt }));
    res.json({ success: true, data: formattedKeys });
  } catch (error) { res.json({ success: true, data: [] }); }
});

app.post('/api/v1/merchant/api-keys/generate', async (req, res) => {
  try {
    const merchantId = getMerchantId(req);
    if (!merchantId) return res.status(401).json({ success: false, error: 'Não autorizado' });
    
    const publicKey = 'pk_live_' + crypto.randomBytes(16).toString('hex');
    const secretKey = 'sk_live_' + crypto.randomBytes(32).toString('hex');
    
    const newKey = await prisma.apiKey.create({ data: { merchantId, merchantName: req.body?.name || 'Chave de Produção', publicKey, secretKey } });
    res.json({ success: true, data: { id: newKey.id, name: newKey.merchantName, publicKey: newKey.publicKey, secretKey: newKey.secretKey, createdAt: newKey.createdAt } });
  } catch (error) { res.status(500).json({ success: false, error: 'Erro ao gerar chave.' }); }
});

app.delete('/api/v1/merchant/api-keys/:id', async (req, res) => {
  try {
    const merchantId = getMerchantId(req);
    if (!merchantId) return res.status(401).json({ success: false, error: 'Não autorizado' });
    
    await prisma.apiKey.deleteMany({ where: { id: req.params.id, merchantId } });
    res.json({ success: true });
  } catch (error) { res.status(500).json({ success: false, error: 'Erro ao eliminar chave.' }); }
});

// 4. PAYMENT LINKS & CHECKOUT INITIATE
app.get('/api/v1/merchant/links', async (req, res) => {
  try {
    const merchantId = getMerchantId(req);
    if (!merchantId) return res.status(401).json({ success: false, error: 'Não autorizado' });
    const stores = await prisma.store.findMany({ where: { merchantId }, select: { id: true } });
    const links = await prisma.paymentLink.findMany({ where: { storeId: { in: stores.map(s => s.id) } }, take: 10, orderBy: { createdAt: 'desc' }, include: { store: true } });
    res.json({ success: true, data: links });
  } catch (error) { res.json({ success: true, data: [] }); }
});

app.post('/api/v1/merchant/links', async (req, res) => {
  try {
    const merchantId = getMerchantId(req);
    if (!merchantId) return res.status(401).json({ success: false, error: 'Não autorizado' });
    const { storeId, name, amountFiat, currency, description } = req.body;
    const newLink = await prisma.paymentLink.create({ data: { storeId, name, amountFiat, currency: currency || 'EUR', description, urlCode: crypto.randomBytes(6).toString('hex') } });
    res.json({ success: true, data: newLink });
  } catch (error) { res.status(500).json({ success: false, error: 'Erro ao gerar link.' }); }
});

app.get('/api/v1/payment-links/:urlCode', async (req, res) => {
  try {
    const link = await prisma.paymentLink.findUnique({ where: { urlCode: req.params.urlCode }, include: { store: true } });
    if (!link) return res.status(404).json({ success: false, error: 'Link não encontrado' });
    res.json({ success: true, data: { id: link.id, storeId: link.storeId, name: link.name, amountFiat: Number(link.amountFiat), currency: link.currency, branding: { storeName: link.store.name, logo: link.store.logoUrl, color: link.store.primaryColor || '#111111' } } });
  } catch (error) { res.status(500).json({ success: false, error: 'Erro ao carregar.' }); }
});

app.post('/api/v1/checkout/initiate', async (req, res) => {
  try {
    const { storeId, amountFiat, currency, customerDetails } = req.body;
    const store = await prisma.store.findUnique({ where: { id: storeId } });
    if (!store) return res.status(404).json({ success: false, error: 'Loja inválida' });

    const customer = await prisma.customer.upsert({
      where: { merchantId_email: { merchantId: store.merchantId, email: customerDetails.email } },
      update: { name: customerDetails.fullName, country: customerDetails.country } as any,
      create: { merchantId: store.merchantId, email: customerDetails.email, name: customerDetails.fullName }
    });

    const tx = await prisma.transaction.create({
      data: { merchantId: store.merchantId, storeId: store.id, customerId: customer.id, amountFiat, currency, exchangeRate: 1.0, amountUSDT: amountFiat, feeUSDT: 0, netAmountUSDT: amountFiat, status: 'PENDING_GATEWAY', customerEmail: customerDetails.email }
    });

    let gateway = 'STRIPE_PT_002';
    let checkoutData = {};
    if (currency === 'BRL') {
      gateway = 'MISTIC_BR_001'; checkoutData = { pixCode: '00020101021226580014br.gov.bcb.pix...', providerTxId: tx.id };
    } else {
      gateway = 'STRIPE_PT_002'; checkoutData = { clientSecret: 'pi_mock_secret_123', providerTxId: tx.id, publishableKey: 'pk_test_mock_123' };
    }
    res.json({ success: true, data: { gateway, checkoutData } });
  } catch (error) { res.status(500).json({ success: false, error: 'Erro ao iniciar transação' }); }
});

// 5. WALLETS & RATES
app.get('/api/v1/public/rates', (req, res) => { res.json({ success: true, data: { USDT_BRL: 5.15, EUR_USDT: 1.08, BTC_USDT: 64200.50, ETH_USDT: 3450.75 } }); });
app.get('/api/v1/wallets', (req, res) => { res.json({ success: true, data: [{ id: 'w_1', currency: 'USDT', balance: 0.00, network: 'TRC20', status: 'ACTIVE' }] }); });
app.get('/api/health', (req, res) => res.json({ status: 'online', version: '2.1.0-api-keys' }));
app.listen(PORT, () => console.log(`🚀 API rodando na porta ${PORT}`));
