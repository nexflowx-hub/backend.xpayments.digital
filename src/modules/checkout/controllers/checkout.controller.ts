import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { executePayment } from '../../payments/services/payment.service';
import { executeCheckoutOrchestratedPayment } from '../services/checkout-orchestrator.service';
import crypto from 'crypto';

const prisma = new PrismaClient();

const PAYMENT_LABELS: Record<string, string> = {
  card: 'Cartão',
  stripe_all: 'Mais opções',
  mb_way: 'MB WAY',
  multibanco: 'Multibanco',
  bizum: 'Bizum',
  bancontact: 'Bancontact',
  blik: 'BLIK',
  revolut_pay: 'Revolut Pay',
  amazon_pay: 'Amazon Pay',
  satispay: 'Satispay'
};

const CHECKOUT_METHODS = new Set(Object.keys(PAYMENT_LABELS));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTERNAL_STRIPE_WEBHOOK_URL =
  process.env.XPAYMENTS_INTERNAL_STRIPE_WEBHOOK_URL ||
  'http://127.0.0.1:8084/api/v1/payments/webhooks/stripe';
const providerReconcileAt = new Map<string, number>();
const PROVIDER_RECONCILE_MIN_AGE_MS = 10_000;
const PROVIDER_RECONCILE_THROTTLE_MS = 10_000;

const normaliseMethod = (value: unknown): string => {
  const method = String(value ?? '').trim().toLowerCase().replace(/-/g, '_');
  return method === 'mbway' ? 'mb_way' : method;
};

const parseRoutingRules = (value: unknown): Record<string, string> => {
  try {
    if (typeof value === 'string') return JSON.parse(value);
    if (value && typeof value === 'object') return value as Record<string, string>;
  } catch {}
  return {};
};

const parseStoreTheme = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return { mode: value === 'dark' ? 'dark' : 'light' };
  }
};

const safeHttpsUrl = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol === 'https:' || url.hostname === 'localhost') return url.toString();
  } catch {}
  return undefined;
};

const publicMetadata = (metadata: unknown) => {
  const source = metadata && typeof metadata === 'object'
    ? metadata as Record<string, unknown>
    : {};

  const allowed = [
    'description',
    'customerName',
    'customerEmail',
    'returnUrl',
    'allowedOrigin',
    'theme',
    'primaryColor',
    'checkoutDisplayName',
    'autoReturnSeconds'
  ];

  return Object.fromEntries(
    allowed
      .filter((key) => source[key] !== undefined && source[key] !== null)
      .map((key) => [key, source[key]])
  );
};

const providerEventType = (paymentIntent: any): string | null => {
  const status = String(paymentIntent?.status || '').toLowerCase();
  if (status === 'succeeded') return 'payment_intent.succeeded';
  if (status === 'processing') return 'payment_intent.processing';
  if (status === 'canceled') return 'payment_intent.canceled';
  if (status === 'requires_payment_method') return 'payment_intent.payment_failed';
  return null;
};

async function reconcilePendingStripeTransaction(transaction: any): Promise<boolean> {
  const providerId = String(transaction?.providerId || '').trim();
  if (!providerId.startsWith('pi_')) return false;

  const createdAt = transaction?.createdAt ? new Date(transaction.createdAt).getTime() : 0;
  if (createdAt && Date.now() - createdAt < PROVIDER_RECONCILE_MIN_AGE_MS) return false;

  const previous = providerReconcileAt.get(transaction.id) || 0;
  if (Date.now() - previous < PROVIDER_RECONCILE_THROTTLE_MS) return false;
  providerReconcileAt.set(transaction.id, Date.now());

  try {
    const vault = transaction.gatewayVaultId
      ? await prisma.gatewayVault.findUnique({ where: { id: transaction.gatewayVaultId } })
      : null;

    const credentials = vault?.credentials as any;
    const secretKey = String(credentials?.secretKey || '').trim();
    if (!secretKey || !vault?.provider?.toLowerCase().startsWith('stripe')) return false;

    const stripeResponse = await fetch(
      `https://api.stripe.com/v1/payment_intents/${encodeURIComponent(providerId)}`,
      { headers: { Authorization: `Bearer ${secretKey}` } }
    );

    if (!stripeResponse.ok) {
      console.warn('[checkout.providerReconcile] stripe retrieve failed', {
        transactionId: transaction.id,
        providerId,
        status: stripeResponse.status
      });
      return false;
    }

    const paymentIntent = await stripeResponse.json();
    const eventType = providerEventType(paymentIntent);
    if (!eventType) return false;

    const replayResponse = await fetch(INTERNAL_STRIPE_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: `evt_xpayments_checkout_reconcile_${providerId}_${paymentIntent.status}`,
        object: 'event',
        type: eventType,
        data: { object: paymentIntent }
      })
    });

    if (!replayResponse.ok) {
      console.warn('[checkout.providerReconcile] internal webhook replay failed', {
        transactionId: transaction.id,
        providerId,
        eventType,
        status: replayResponse.status
      });
      return false;
    }

    providerReconcileAt.delete(transaction.id);
    console.log('[checkout.providerReconcile] recovered', {
      transactionId: transaction.id,
      providerId,
      eventType
    });
    return true;
  } catch (error: any) {
    console.warn('[checkout.providerReconcile] failed', {
      transactionId: transaction?.id,
      providerId,
      message: error?.message || String(error)
    });
    return false;
  }
}

async function resolveSessionStatus(session: any): Promise<{
  status: string;
  transactionId?: string;
}> {
  let status = String(session.status || 'pending').toLowerCase();
  let transactionId: string | undefined;

  if (session.reference) {
    let transaction = await prisma.transaction.findFirst({
      where: {
        storeId: session.storeId,
        reference: session.reference
      },
      orderBy: { createdAt: 'desc' }
    });

    if (transaction) {
      transactionId = transaction.id;
      const initialTxStatus = String(transaction.status || '').toLowerCase();

      if (['pending', 'processing'].includes(initialTxStatus)) {
        const reconciled = await reconcilePendingStripeTransaction(transaction);
        if (reconciled) {
          transaction = await prisma.transaction.findUnique({ where: { id: transaction.id } });
        }
      }

      const txStatus = String(transaction?.status || '').toLowerCase();
      if (txStatus === 'succeeded') status = 'succeeded';
      else if (['failed', 'cancelled', 'canceled'].includes(txStatus)) status = 'failed';
      else if (txStatus) status = 'pending';
    }
  }

  if (
    status !== 'succeeded' &&
    session.expiresAt &&
    new Date(session.expiresAt).getTime() <= Date.now()
  ) {
    status = 'expired';
  }

  if (status !== String(session.status || '').toLowerCase()) {
    await prisma.checkoutSession.update({
      where: { id: session.id },
      data: { status }
    }).catch(() => undefined);
  }

  return { status, transactionId };
}

async function resolveCheckoutEnvironment(session: any): Promise<'live' | 'test'> {
  const metadata = session.metadata && typeof session.metadata === 'object'
    ? session.metadata as Record<string, unknown>
    : {};

  const metadataEnv = String(metadata._xpayments_checkout_environment || '').toLowerCase();
  if (metadataEnv === 'test' || metadataEnv === 'live') return metadataEnv;

  const vault = await prisma.gatewayVault.findFirst({
    where: {
      merchantId: session.merchantId,
      isActive: true,
      OR: [{ storeId: session.storeId }, { storeId: null }]
    },
    orderBy: { createdAt: 'desc' }
  });

  const credentials = vault?.credentials as any;
  const secretKey = String(credentials?.secretKey || '');
  return secretKey.includes('_test_') ? 'test' : 'live';
}

export const createSession = async (req: Request, res: Response) => {
  try {
    const {
      amount,
      currency = 'EUR',
      reference,
      customerEmail,
      metadata = {},
      returnUrl,
      allowedOrigin,
      expiresInMinutes
    } = req.body || {};

    const authorization = req.headers.authorization;
    const apiKey = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length).trim()
      : String(req.headers['x-api-key'] || '').trim();

    if (!apiKey) {
      return res.status(401).json({ success: false, message: 'API Key não fornecida.' });
    }

    const keyRecord = await prisma.apiKey.findUnique({
      where: { key: apiKey },
      include: { store: true }
    });

    if (!keyRecord || keyRecord.store.status !== 'active') {
      return res.status(401).json({ success: false, message: 'Acesso negado.' });
    }

    const scopes = Array.isArray((keyRecord as any).scopes) ? (keyRecord as any).scopes : [];
    if (
      scopes.length > 0 &&
      !scopes.some((scope: string) => ['payments_write', 'payments', 'write'].includes(scope))
    ) {
      return res.status(403).json({
        success: false,
        error: { code: 'INSUFFICIENT_SCOPE', message: 'A API Key não possui permissão para criar checkout.' }
      });
    }

    const amountMinor = Number(amount);
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
      return res.status(400).json({ success: false, message: 'amount deve ser um inteiro positivo na menor unidade monetária.' });
    }

    const currencyUpper = String(currency).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currencyUpper)) {
      return res.status(400).json({ success: false, message: 'Moeda inválida.' });
    }

    const sessionId = crypto.randomUUID();
    const checkoutUrl = `https://checkout.xpayments.digital/pay/${sessionId}`;
    const embedUrl = `https://checkout.xpayments.digital/embed/${sessionId}`;
    const minutes = Math.min(1440, Math.max(5, Number(expiresInMinutes) || 30));

    const incomingMetadata = metadata && typeof metadata === 'object'
      ? metadata as Record<string, unknown>
      : {};

    const mergedMetadata: Record<string, unknown> = {
      ...incomingMetadata,
      _xpayments_checkout_environment: String((keyRecord as any).environment || 'test').toLowerCase()
    };

    const safeReturnUrl = safeHttpsUrl(returnUrl ?? incomingMetadata.returnUrl);
    const safeAllowedOrigin = safeHttpsUrl(allowedOrigin ?? incomingMetadata.allowedOrigin);
    if (safeReturnUrl) mergedMetadata.returnUrl = safeReturnUrl;
    if (safeAllowedOrigin) mergedMetadata.allowedOrigin = new URL(safeAllowedOrigin).origin;
    if (customerEmail && !mergedMetadata.customerEmail) mergedMetadata.customerEmail = customerEmail;

    const session = await prisma.checkoutSession.create({
      data: {
        id: sessionId,
        merchantId: keyRecord.store.merchantId,
        storeId: keyRecord.store.id,
        amount: amountMinor / 100,
        checkoutUrl,
        currency: currencyUpper,
        reference: String(reference || `CHK-${keyRecord.store.storeCode}-${Date.now()}`),
        customerEmail: customerEmail || null,
        metadata: mergedMetadata as any,
        status: 'pending',
        expiresAt: new Date(Date.now() + minutes * 60 * 1000)
      }
    });

    return res.status(201).json({
      success: true,
      data: {
        sessionId: session.id,
        checkoutUrl: session.checkoutUrl,
        embedUrl,
        expiresAt: session.expiresAt
      }
    });
  } catch (error) {
    console.error('[checkout.createSession]', error);
    return res.status(500).json({ success: false, message: 'Erro interno.' });
  }
};

export const loadSession = async (req: Request, res: Response) => {
  try {
    const sessionId = String(req.params.sessionId || '').trim();
    if (!UUID_RE.test(sessionId)) {
      return res.status(400).json({ success: false, message: 'ID de sessão inválido.' });
    }

    const session = await prisma.checkoutSession.findUnique({
      where: { id: sessionId },
      include: { store: true }
    });

    if (!session) {
      return res.status(404).json({ success: false, message: 'Sessão não encontrada.' });
    }

    const store = (session as any).store;
    const routingRules = parseRoutingRules(store?.routingRules);
    const paymentMethods = Object.entries(routingRules)
      .map(([rawCode]) => normaliseMethod(rawCode))
      .filter((code, index, all) => CHECKOUT_METHODS.has(code) && all.indexOf(code) === index)
      .map((code) => ({ code, label: PAYMENT_LABELS[code] || code }));

    const hasStripe = Object.values(routingRules).some((provider) =>
      String(provider).toLowerCase().startsWith('stripe')
    );
    if (hasStripe && !paymentMethods.some((method) => method.code === 'stripe_all')) {
      paymentMethods.push({ code: 'stripe_all', label: PAYMENT_LABELS.stripe_all });
    }

    const state = await resolveSessionStatus(session);
    const metadata = publicMetadata(session.metadata) as Record<string, unknown>;
    const storeTheme = parseStoreTheme(store?.theme);
    const displayName = String(
      metadata.checkoutDisplayName || storeTheme.checkoutDisplayName || store?.name || 'Store'
    );
    const themeMode = String(metadata.theme || storeTheme.mode || 'light');
    const primaryColor = String(metadata.primaryColor || storeTheme.primaryColor || '#111111');
    const autoReturnSeconds = Math.min(
      10,
      Math.max(0, Number(metadata.autoReturnSeconds ?? storeTheme.autoReturnSeconds ?? 3))
    );

    return res.status(200).json({
      success: true,
      data: {
        sessionId: session.id,
        storeId: session.storeId,
        storeName: displayName,
        internalStoreName: store?.name || 'Store',
        amount: Number(session.amount),
        currency: session.currency,
        reference: session.reference,
        logoUrl: store?.logoUrl || null,
        theme: themeMode,
        primaryColor,
        autoReturnSeconds,
        localeMode: String(storeTheme.localeMode || 'auto'),
        description: metadata.description || null,
        metadata: {
          ...metadata,
          checkoutDisplayName: displayName,
          autoReturnSeconds
        },
        returnUrl: metadata.returnUrl || null,
        expiresAt: session.expiresAt,
        status: state.status,
        transactionId: state.transactionId || null,
        paymentMethods
      }
    });
  } catch (error) {
    console.error('[checkout.loadSession]', error);
    return res.status(500).json({ success: false, message: 'Erro interno.' });
  }
};

export const initiatePayment = async (req: Request, res: Response) => {
  try {
    const {
      sessionId,
      paymentMethod,
      customer = {},
      returnUrl,
      paymentMethodOptions
    } = req.body || {};

    if (!sessionId || !paymentMethod || !UUID_RE.test(String(sessionId))) {
      return res.status(400).json({ success: false, message: 'Dados incompletos ou sessão inválida.' });
    }

    const session = await prisma.checkoutSession.findUnique({
      where: { id: String(sessionId) },
      include: { store: true }
    });

    if (!session) {
      return res.status(404).json({ success: false, message: 'Sessão inválida.' });
    }

    const state = await resolveSessionStatus(session);
    if (state.status === 'succeeded') {
      return res.status(409).json({ success: false, error: { code: 'CHECKOUT_ALREADY_PAID', message: 'Checkout já pago.' } });
    }
    if (state.status === 'expired') {
      return res.status(410).json({ success: false, error: { code: 'CHECKOUT_EXPIRED', message: 'Checkout expirado.' } });
    }

    const method = normaliseMethod(paymentMethod);
    const routingRules = parseRoutingRules((session as any).store?.routingRules);
    const allowedMethods = new Set(Object.keys(routingRules).map(normaliseMethod));
    const hasStripe = Object.values(routingRules).some((provider) =>
      String(provider).toLowerCase().startsWith('stripe')
    );
    const dynamicStripeAllowed = method === 'stripe_all' && hasStripe;

    if (!CHECKOUT_METHODS.has(method) || (!allowedMethods.has(method) && !dynamicStripeAllowed)) {
      return res.status(400).json({
        success: false,
        error: { code: 'CHECKOUT_METHOD_NOT_AVAILABLE', message: `Método ${method} não disponível nesta Store.` }
      });
    }

    const metadata = session.metadata && typeof session.metadata === 'object'
      ? session.metadata as Record<string, unknown>
      : {};

    const checkoutReturnUrl =
      safeHttpsUrl(returnUrl) ||
      safeHttpsUrl(metadata.returnUrl) ||
      `https://checkout.xpayments.digital/pay/${session.id}?return=1`;

    const environment = await resolveCheckoutEnvironment(session);
    const amountMinor = Math.round(Number(session.amount) * 100);
    const merchantReference = session.reference || `CHK-${session.id}`;

    let result: any;

    if (method === 'card' || method === 'stripe_all') {
      result = await executePayment({
        amount: amountMinor,
        currency: session.currency,
        paymentMethod: method,
        storeId: session.storeId,
        metadata: {
          checkoutSessionId: session.id,
          customerEmail: session.customerEmail,
          ...customer
        },
        merchantReference,
        environment
      });
    } else {
      const orchestrated = await executeCheckoutOrchestratedPayment({
        storeId: session.storeId,
        environment,
        amountMinor,
        currency: session.currency,
        reference: merchantReference,
        paymentMethod: method,
        customer,
        returnUrl: checkoutReturnUrl,
        paymentMethodOptions,
        checkoutSessionId: session.id
      });

      const action = orchestrated?.action || null;
      let checkoutData: Record<string, unknown> = {
        providerTxId: orchestrated?.providerId,
        status: orchestrated?.status,
        actionType: action?.type || null,
        message: action?.message || null
      };

      if (action?.type === 'multibanco_reference') {
        checkoutData = {
          entity: String(action.entidade || ''),
          reference: String(action.referencia || ''),
          amount: Number(session.amount),
          providerTxId: orchestrated?.providerId,
          status: orchestrated?.status
        };
      } else if (action?.url) {
        checkoutData = {
          ...checkoutData,
          redirectUrl: String(action.url)
        };
      }

      result = {
        gateway: 'XPAYMENTS',
        transactionId: orchestrated?.transactionId,
        providerId: orchestrated?.providerId,
        status: orchestrated?.status,
        method: orchestrated?.method || method,
        action,
        checkoutData
      };
    }

    return res.status(200).json({ success: true, data: result });
  } catch (error: any) {
    console.error('[checkout.initiatePayment]', {
      code: error?.code,
      message: error?.message
    });

    return res.status(error?.status && error.status >= 400 && error.status < 600 ? error.status : 400).json({
      success: false,
      error: {
        code: error?.code || 'CHECKOUT_INITIATE_FAILED',
        message: error?.message || 'Erro ao iniciar pagamento.'
      },
      message: error?.message || 'Erro ao iniciar pagamento.'
    });
  }
};
