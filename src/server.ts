import express from 'express';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { GatewayRouter } from './services/gateways';

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
    return (jwt.verify(token, JWT_SECRET) as any).id;
  } catch (e) { return null; }
};

const dispatchWebhook = async (storeId: string, event: string, payload: any) => {
  try {
    const store = await prisma.store.findUnique({ where: { id: storeId } });
    if (store && store.webhookUrl) {
      console.log(`[WEBHOOK OUT] A disparar evento ${event} para ${store.webhookUrl}`);
      fetch(store.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-xpayments-signature': crypto.randomBytes(16).toString('hex') },
        body: JSON.stringify({ event, data: payload, timestamp: new Date() })
      }).catch(() => console.log(`[WEBHOOK FAIL] Falha na entrega a ${store.webhookUrl}`));
    }
  } catch (error) { console.error('[WEBHOOK ERROR]', error); }
};

const isValidUUID = (uuid: any) => typeof uuid === 'string' && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(uuid);

// ==========================================
// 1. AUTH & ADMIN
// ==========================================
app.post('/api/v1/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const merchant = await prisma.merchant.findUnique({ where: { email } });
    if (!merchant || merchant.password !== password) return res.status(401).json({ success: false, error: 'Credenciais inválidas.' });
    if (merchant.status !== 'ACTIVE') return res.status(403).json({ success: false, error: 'Conta suspensa.' });
    const token = jwt.sign({ id: merchant.id, role: 'merchant' }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ success: true, data: { merchantId: merchant.id, name: merchant.name, tier: merchant.tier, token, role: 'merchant' } });
  } catch (error) { res.status(500).json({ success: false }); }
});

app.post('/api/v1/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const admin = await prisma.adminUser.findUnique({ where: { email } });
    if (!admin || admin.password !== password) return res.status(401).json({ success: false });
    const token = jwt.sign({ id: admin.id, role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ success: true, data: { adminId: admin.id, name: admin.name, role: 'admin', token } });
  } catch (error) { res.status(500).json({ success: false }); }
});

app.get('/api/v1/admin/stats', async (req, res) => {
  try {
    const totalMerchants = await prisma.merchant.count();
    const activeMerchants = await prisma.merchant.count({ where: { status: 'ACTIVE' } });
    const totalTransactions = await prisma.transaction.count();
    const volume = await prisma.transaction.aggregate({ _sum: { amountUSDT: true } });
    const pendingTickets = await prisma.supportTicket.count({ where: { status: 'OPEN' } });
    res.json({ success: true, data: { totalMerchants, activeMerchants, totalTransactions, totalVolumeUSDT: volume._sum.amountUSDT || 0, pendingTickets } });
  } catch (error) { res.status(500).json({ success: false }); }
});

app.get('/api/v1/admin/merchants', async (req, res) => {
  try {
    const merchants = await prisma.merchant.findMany({ include: { _count: { select: { stores: true } } }, orderBy: { createdAt: 'desc' } });
    const formatted = await Promise.all(merchants.map(async (m) => {
      const vol = await prisma.transaction.aggregate({ where: { merchantId: m.id }, _sum: { amountUSDT: true } });
      return { id: m.id, name: m.name, email: m.email, tier: m.tier, status: m.status, activeStores: m._count.stores, totalVolume: vol._sum.amountUSDT || 0 };
    }));
    res.json({ success: true, data: formatted });
  } catch (error) { res.status(500).json({ success: false }); }
});

// ==========================================
// 2. CORE DASHBOARD & WALLET
// ==========================================
app.get('/api/v1/merchant/:id/dashboard', async (req, res) => {
  try {
    const ledgers = await prisma.ledger.groupBy({ by: ['status'], where: { merchantId: req.params.id }, _sum: { amountUSDT: true } });
    const balances = { incoming: 0, pending: 0, reserve: 0, available: 0 };
    ledgers.forEach(l => { const key = l.status.toLowerCase(); if (key in balances) (balances as any)[key] = Number(l._sum.amountUSDT) || 0; });
    res.json({ success: true, data: { balances } });
  } catch (error) { res.status(500).json({ success: false }); }
});

app.get('/api/v1/merchant/:id/transactions', async (req, res) => {
  try {
    const txs = await prisma.transaction.findMany({ where: { merchantId: req.params.id }, orderBy: { createdAt: 'desc' }, take: 10, include: { store: { select: { name: true } } } });
    const formatted = txs.map(tx => ({ id: tx.id, amount: Number(tx.amountUSDT), fiatAmount: Number(tx.amountFiat), fiatCurrency: tx.currency, status: tx.status, createdAt: tx.createdAt, store: tx.store }));
    res.json({ success: true, data: formatted });
  } catch (error) { res.status(500).json({ success: false }); }
});

app.get('/api/v1/wallets', async (req, res) => {
  try {
    const merchantId = getMerchantId(req);
    if (!merchantId) return res.status(401).json({ success: false });
    const ledgers = await prisma.ledger.aggregate({ where: { merchantId, status: 'AVAILABLE' }, _sum: { amountUSDT: true } });
    const balance = Number(ledgers._sum.amountUSDT) || 0;
    res.json({ success: true, data: [{ id: 'wallet_main_usdt', currency: 'USDT', balance, network: 'TRC20', status: 'ACTIVE' }] });
  } catch (error) { res.status(500).json({ success: false }); }
});

// ==========================================
// 3. STORES & API KEYS (Integração B2B)
// ==========================================
app.get('/api/v1/merchant/:id/stores', async (req, res) => {
  try {
    const stores = await prisma.store.findMany({ where: { merchantId: req.params.id }, orderBy: { createdAt: 'desc' } });
    res.json({ success: true, data: stores });
  } catch (error) { res.status(500).json({ success: false }); }
});

app.post('/api/v1/merchant/:id/stores', async (req, res) => {
  try {
    const { name, primaryColor, successUrl, webhookUrl } = req.body;
    const newStore = await prisma.store.create({
      data: { merchantId: req.params.id, name: name || 'Nova Loja', primaryColor: primaryColor || '#10b981', successUrl: successUrl || '', webhookUrl: webhookUrl || '', checkoutConfig: { allowedMethods: ["CARD", "MBWAY", "PIX"], defaultCurrency: "EUR" } }
    });
    res.json({ success: true, data: newStore });
  } catch (error) { res.status(500).json({ success: false }); }
});

app.get('/api/v1/merchant/api-keys', async (req, res) => {
  try {
    const merchantId = getMerchantId(req);
    const keys = await prisma.apiKey.findMany({ where: { merchantId }, orderBy: { createdAt: 'desc' } });
    res.json({ success: true, data: keys });
  } catch (error) { res.json({ success: true, data: [] }); }
});

app.post('/api/v1/merchant/api-keys/generate', async (req, res) => {
  try {
    const merchantId = getMerchantId(req);
    const publicKey = 'pk_live_' + crypto.randomBytes(16).toString('hex');
    const secretKey = 'sk_live_' + crypto.randomBytes(32).toString('hex');
    const newKey = await prisma.apiKey.create({ data: { merchantId, merchantName: req.body?.name || 'Chave API', publicKey, secretKey } });
    res.json({ success: true, data: newKey });
  } catch (error) { res.status(500).json({ success: false }); }
});

app.delete('/api/v1/merchant/api-keys/:id', async (req, res) => {
  try {
    const merchantId = getMerchantId(req);
    await prisma.apiKey.deleteMany({ where: { id: req.params.id, merchantId } });
    res.json({ success: true });
  } catch (error) { res.status(500).json({ success: false }); }
});

// ==========================================
// 4. E-COMMERCE: CATÁLOGO DE PRODUTOS
// ==========================================
app.get('/api/v1/merchant/products', async (req, res) => {
  try {
    const merchantId = getMerchantId(req);
    if (!merchantId) return res.status(401).json({ success: false });
    const stores = await prisma.store.findMany({ where: { merchantId }, select: { id: true }});
    const products = await prisma.product.findMany({ where: { storeId: { in: stores.map(s => s.id) } }, orderBy: { createdAt: 'desc' }, include: { store: true }});
    res.json({ success: true, data: products });
  } catch (error) { res.status(500).json({ success: false }); }
});

app.post('/api/v1/merchant/products', async (req, res) => {
  try {
    const merchantId = getMerchantId(req);
    let { storeId, name, description, category, priceFiat, currency, images, metadata } = req.body;

    if (!isValidUUID(storeId)) {
      const firstStore = await prisma.store.findFirst({ where: { merchantId } });
      storeId = firstStore ? firstStore.id : (await prisma.store.create({ data: { merchantId, name: 'Loja Principal', isActive: true } })).id;
    }

    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + crypto.randomBytes(2).toString('hex');
    const newProduct = await prisma.product.create({ data: { storeId, name, slug, description, category, priceFiat: Number(priceFiat) || 0, currency: currency || 'EUR', images: images || [], metadata: metadata || {} } });
    res.json({ success: true, data: newProduct });
  } catch (error) { res.status(500).json({ success: false }); }
});

// 🔴 NOVO: EDITAR PRODUTO
app.put('/api/v1/merchant/products/:id', async (req, res) => {
  try {
    const merchantId = getMerchantId(req);
    if (!merchantId) return res.status(401).json({ success: false });
    
    // Verifica propriedade (O Lojista é dono desta store?)
    const p = await prisma.product.findUnique({ where: { id: req.params.id }, include: { store: true } });
    if (!p || p.store.merchantId !== merchantId) return res.status(404).json({ success: false });

    const { name, description, priceFiat, currency, isActive } = req.body;
    
    const updated = await prisma.product.update({
      where: { id: req.params.id },
      data: {
        name: name !== undefined ? name : undefined,
        description: description !== undefined ? description : undefined,
        priceFiat: priceFiat !== undefined ? Number(priceFiat) : undefined,
        currency: currency !== undefined ? currency : undefined,
        isActive: isActive !== undefined ? isActive : undefined,
      }
    });
    res.json({ success: true, data: updated });
  } catch (error) { res.status(500).json({ success: false }); }
});

// 🔴 NOVO: APAGAR PRODUTO
app.delete('/api/v1/merchant/products/:id', async (req, res) => {
  try {
    const merchantId = getMerchantId(req);
    if (!merchantId) return res.status(401).json({ success: false });
    
    const p = await prisma.product.findUnique({ where: { id: req.params.id }, include: { store: true } });
    if (!p || p.store.merchantId !== merchantId) return res.status(404).json({ success: false });

    await prisma.product.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (error) { res.status(500).json({ success: false }); }
});


// ==========================================
// 5. E-COMMERCE: LINKS DE PAGAMENTO
// ==========================================
app.get('/api/v1/merchant/links', async (req, res) => {
  try {
    const merchantId = getMerchantId(req);
    if (!merchantId) return res.status(401).json({ success: false });
    const stores = await prisma.store.findMany({ where: { merchantId }, select: { id: true } });
    const links = await prisma.paymentLink.findMany({ where: { storeId: { in: stores.map(s => s.id) } }, orderBy: { createdAt: 'desc' }, include: { store: true } });

    const mappedLinks = links.map(l => ({
      ...l,
      amount: Number(l.amountFiat),
      url: `https://checkout.xpayments.digital/pay/${l.urlCode}`
    }));

    res.json({ success: true, data: mappedLinks });
  } catch (error) { res.json({ success: true, data: [] }); }
});

app.post('/api/v1/merchant/links', async (req, res) => {
  try {
    const merchantId = getMerchantId(req);
    if (!merchantId) return res.status(401).json({ success: false, error: 'Não autorizado' });

    let { storeId, productId, name, amountFiat, amount, currency, description } = req.body;

    if (!isValidUUID(storeId)) {
      const firstStore = await prisma.store.findFirst({ where: { merchantId } });
      storeId = firstStore ? firstStore.id : (await prisma.store.create({ data: { merchantId, name: 'Loja Principal', isActive: true } })).id;
    }

    const validProductId = isValidUUID(productId) ? productId : null;
    const rawAmount = amountFiat !== undefined ? amountFiat : amount;
    const safeAmount = isNaN(Number(rawAmount)) ? 0 : Number(rawAmount);

    let imageUrl = null;
    if (validProductId) {
      const p = await prisma.product.findUnique({ where: { id: validProductId }});
      if (p && p.images && p.images.length > 0) imageUrl = p.images[0];
      if (!name && p) name = p.name;
    }

    const newLink = await prisma.paymentLink.create({
      data: {
        storeId,
        productId: validProductId,
        name: name || description || 'Pagamento XPayments',
        amountFiat: safeAmount,
        currency: currency || 'BRL',
        description: description || '',
        imageUrl,
        urlCode: crypto.randomBytes(6).toString('hex')
      }
    });

    res.json({
      success: true,
      data: {
        ...newLink,
        amount: Number(newLink.amountFiat),
        url: `https://checkout.xpayments.digital/pay/${newLink.urlCode}`
      }
    });
  } catch (error: any) {
    console.error('❌ ERRO PRISMA:', error);
    res.status(500).json({ success: false });
  }
});

// 🔴 NOVO: EDITAR LINK
app.put('/api/v1/merchant/links/:id', async (req, res) => {
  try {
    const merchantId = getMerchantId(req);
    if (!merchantId) return res.status(401).json({ success: false });
    
    const l = await prisma.paymentLink.findUnique({ where: { id: req.params.id }, include: { store: true } });
    if (!l || l.store.merchantId !== merchantId) return res.status(404).json({ success: false });

    const { name, amountFiat, currency, isActive } = req.body;
    
    const updated = await prisma.paymentLink.update({
      where: { id: req.params.id },
      data: {
        name: name !== undefined ? name : undefined,
        amountFiat: amountFiat !== undefined ? Number(amountFiat) : undefined,
        currency: currency !== undefined ? currency : undefined,
        isActive: isActive !== undefined ? isActive : undefined,
      }
    });
    res.json({ success: true, data: updated });
  } catch (error) { res.status(500).json({ success: false }); }
});

// 🔴 NOVO: APAGAR LINK
app.delete('/api/v1/merchant/links/:id', async (req, res) => {
  try {
    const merchantId = getMerchantId(req);
    if (!merchantId) return res.status(401).json({ success: false });
    
    const l = await prisma.paymentLink.findUnique({ where: { id: req.params.id }, include: { store: true } });
    if (!l || l.store.merchantId !== merchantId) return res.status(404).json({ success: false });

    await prisma.paymentLink.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (error) { res.status(500).json({ success: false }); }
});


app.get('/api/v1/payment-links/:urlCode', async (req, res) => {
  try {
    // 🔴 Proteção: Links inativos não abrem
    const link = await prisma.paymentLink.findFirst({ where: { urlCode: req.params.urlCode, isActive: true }, include: { store: true, product: true } });
    if (!link) return res.status(404).json({ success: false, error: 'Link não encontrado ou expirado' });
    res.json({ success: true, data: { id: link.id, storeId: link.storeId, name: link.name, amountFiat: Number(link.amountFiat), currency: link.currency, productImage: link.imageUrl || (link.product && link.product.images[0]) || null, branding: { storeName: link.store.name, logo: link.store.logoUrl, color: link.store.primaryColor || '#111111' }, successUrl: link.store.successUrl } });
  } catch (error) { res.status(500).json({ success: false }); }
});

// ==========================================
// 6. CHECKOUT API (O CÉREBRO B2B)
// ==========================================

app.post('/api/v1/checkout/sessions', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer sk_')) return res.status(401).json({ success: false, error: 'Chave Inválida' });
    const secretKey = authHeader.split(' ')[1];
    const apiKey = await prisma.apiKey.findFirst({ where: { secretKey, isActive: true } });
    if (!apiKey) return res.status(401).json({ success: false, error: 'Não autorizado' });

    const { storeId, amountFiat, currency, orderId } = req.body;
    let finalStoreId = isValidUUID(storeId) ? storeId : null;
    if (!finalStoreId) {
      const firstStore = await prisma.store.findFirst({ where: { merchantId: apiKey.merchantId } });
      if (firstStore) finalStoreId = firstStore.id;
      else return res.status(404).json({ success: false, error: 'Nenhuma Store encontrada.' });
    }

    const sessionId = 'cs_' + crypto.randomBytes(16).toString('hex');
    const session = await prisma.paymentLink.create({
      data: { storeId: finalStoreId, name: `Order #${orderId || 'API'}`, amountFiat: Number(amountFiat) || 0, currency: currency || 'EUR', description: `Sessão API`, urlCode: sessionId, isReusable: false }
    });

    res.json({ success: true, id: sessionId, url: `https://checkout.xpayments.digital/pay/${sessionId}` });
  } catch (error) { res.status(500).json({ success: false }); }
});

app.post('/api/v1/checkout/initiate', async (req, res) => {
  try {
    console.log('\n--- 🔴 NOVO PEDIDO DE INITIATE ---');

    const { storeId, amountFiat, currency, customerDetails } = req.body;

    if (!isValidUUID(storeId)) return res.status(400).json({ success: false, error: 'StoreID inválido' });

    const store = await prisma.store.findUnique({ where: { id: storeId }, include: { merchant: true } });
    if (!store) return res.status(404).json({ success: false, error: 'Loja não encontrada' });

    const amountNum = Number(amountFiat);
    if (isNaN(amountNum) || amountNum <= 0) return res.status(400).json({ success: false, error: 'Valor inválido' });

    const currentRates: Record<string, number> = { BRL: 0.194, EUR: 1.08, USD: 1.0, USDT: 1.0 };
    const exchangeRate = currentRates[currency] || 1.0;

    const amountUSDT = amountNum * exchangeRate;
    const feePercent = store.merchant.customFeePercent ? Number(store.merchant.customFeePercent) : 2.5; 
    const feeUSDT = amountUSDT * (feePercent / 100);
    const netAmountUSDT = amountUSDT - feeUSDT;

    const safeEmail = customerDetails?.email || 'guest@xpayments.digital';
    const safeName = customerDetails?.fullName || 'Cliente Guest';
    const safeTaxId = customerDetails?.taxId || null;

    const customer = await prisma.customer.upsert({
      where: { merchantId_email: { merchantId: store.merchantId, email: safeEmail } },
      update: { name: safeName, taxId: safeTaxId } as any,
      create: { merchantId: store.merchantId, email: safeEmail, name: safeName, taxId: safeTaxId }
    });

    const tx = await prisma.transaction.create({
      data: {
        merchantId: store.merchantId,
        storeId: store.id,
        customerId: customer.id,
        type: 'CHECKOUT',
        merchantName: store.merchant.name,
        storeName: store.name,             
        amountFiat: amountNum,
        currency,
        exchangeRate,                      
        amountUSDT,
        feeUSDT,
        netAmountUSDT,
        status: 'PENDING_GATEWAY',
        customerEmail: safeEmail
      }
    });

    const gatewayResponse = await GatewayRouter.routePayment(currency, tx.id, amountNum, { fullName: safeName, email: safeEmail, taxId: safeTaxId }, store.name);

    await prisma.transaction.update({
      where: { id: tx.id },
      data: { providerUsed: gatewayResponse.gateway, providerTxId: gatewayResponse.providerTxId }
    });

    res.json({ success: true, data: { gateway: gatewayResponse.gateway, checkoutData: { ...gatewayResponse, providerTxId: tx.id } } });
  } catch (error: any) {
    console.error('❌ [ERRO INITIATE FATAL]:', error);
    res.status(500).json({ success: false, error: error.message || 'Erro interno no Gateway' });
  }
});

// ==========================================
// 7. WEBHOOKS & SIMULADORES (A Faturação Real!)
// ==========================================

app.post('/api/v1/webhooks/misticpay', async (req, res) => {
  try {
    const payload = req.body;
    console.log('[WEBHOOK MISTICPAY] Recebido:', payload);

    if (payload.status === 'COMPLETO' && payload.transactionType === 'DEPOSITO') {
      const tx = await prisma.transaction.findFirst({ where: { providerTxId: String(payload.transactionId), providerUsed: 'MISTICPAY' } });

      if (tx && tx.status !== 'SUCCESS') {
        await prisma.transaction.update({ where: { id: tx.id }, data: { status: 'SUCCESS' } });

        await prisma.ledger.create({
          data: { merchantId: tx.merchantId, transactionId: tx.id, type: 'PAYMENT', amountUSDT: Number(tx.netAmountUSDT), status: 'AVAILABLE', availableAt: new Date() }
        });

        if (tx.storeId) await dispatchWebhook(tx.storeId, 'payment.success', { transactionId: tx.id, amount: Number(tx.amountFiat), currency: tx.currency, customer: tx.customerEmail });
      }
    }
    res.status(200).json({ received: true });
  } catch (error) { res.status(500).json({ error: 'Internal Server Error' }); }
});

app.post('/api/v1/webhooks/stripe', async (req, res) => {
  try {
    const event = req.body;
    console.log('[WEBHOOK STRIPE] Evento Recebido:', event.type);

    if (event.type === 'payment_intent.succeeded') {
      const paymentIntent = event.data.object;
      const txId = paymentIntent.metadata?.transactionId;

      if (txId) {
        const tx = await prisma.transaction.findUnique({ where: { id: txId } });
        if (tx && tx.status !== 'SUCCESS') {
          await prisma.transaction.update({ where: { id: tx.id }, data: { status: 'SUCCESS' } });

          await prisma.ledger.create({
            data: { merchantId: tx.merchantId, transactionId: tx.id, type: 'PAYMENT', amountUSDT: Number(tx.netAmountUSDT), status: 'INCOMING' }
          });

          if (tx.storeId) await dispatchWebhook(tx.storeId, 'payment.success', { transactionId: tx.id, amount: Number(tx.amountFiat), currency: tx.currency, customer: tx.customerEmail });
        }
      }
    }
    res.status(200).json({ received: true });
  } catch (error) { res.status(500).json({ error: 'Erro Webhook Stripe' }); }
});

app.post('/api/v1/checkout/simulate-success', async (req, res) => {
  try {
    const { providerTxId } = req.body;
    const tx = await prisma.transaction.findFirst({ where: { providerTxId } });

    if (tx && tx.status !== 'SUCCESS') {
      await prisma.transaction.update({ where: { id: tx.id }, data: { status: 'SUCCESS' } });

      await prisma.ledger.create({
        data: { merchantId: tx.merchantId, transactionId: tx.id, type: 'PAYMENT', amountUSDT: Number(tx.netAmountUSDT), status: 'AVAILABLE', availableAt: new Date() }
      });

      if (tx.storeId) await dispatchWebhook(tx.storeId, 'payment.success', { transactionId: tx.id, amount: Number(tx.amountFiat), currency: tx.currency, customer: tx.customerEmail });
    }

    res.json({ success: true, message: 'Faturação concluída.' });
  } catch (error) { res.status(500).json({ success: false }); }
});

app.get('/api/health', (req, res) => res.json({ status: 'online', version: '10.1.0-ecommerce-crud' }));

app.listen(PORT, () => console.log(`🚀 XPayments Master API rodando na porta ${PORT}`));
