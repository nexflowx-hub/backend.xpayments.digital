import crypto from 'crypto';
import { Response } from 'express';
import prisma from '../../../core/prisma';
import { AuthRequest } from '../../../middleware/auth.middleware';

const PAYMENT_METHOD_CODES = new Set([
  'card',
  'mb_way',
  'multibanco',
  'bizum',
  'pix',
  'apple_pay',
  'google_pay',
  'bancontact',
  'blik',
  'ideal',
  'eps',
  'klarna',
  'amazon_pay'
]);

const requestedMerchantId = (req: AuthRequest): string | null => {
  const value = (req.params as any)?.merchantId;
  if (!value) return null;
  return Array.isArray(value) ? String(value[0]) : String(value);
};

const authenticatedMerchantId = (req: AuthRequest): string | null =>
  req.user?.id ? String(req.user.id) : null;

const authorizeMerchantPath = (req: AuthRequest, res: Response): string | null => {
  const merchantId = authenticatedMerchantId(req);
  if (!merchantId) {
    res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Merchant não autenticado.' }
    });
    return null;
  }

  const pathMerchantId = requestedMerchantId(req);
  if (pathMerchantId && pathMerchantId !== merchantId) {
    res.status(403).json({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Acesso negado a este Merchant.' }
    });
    return null;
  }

  return merchantId;
};

const validOptionalUrl = (value: unknown): string | null => {
  const text = String(value ?? '').trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.toString();
  } catch {
    return null;
  }
};

const storeConfig = (routingRules: unknown): Record<string, unknown> => {
  if (!routingRules || typeof routingRules !== 'object' || Array.isArray(routingRules)) return {};
  const config = (routingRules as Record<string, unknown>)._config;
  return config && typeof config === 'object' && !Array.isArray(config)
    ? config as Record<string, unknown>
    : {};
};

const paymentMethodsFromRouting = (routingRules: unknown): string[] => {
  if (!routingRules || typeof routingRules !== 'object' || Array.isArray(routingRules)) return [];
  const rules = routingRules as Record<string, unknown>;
  return Object.keys(rules).filter(code => PAYMENT_METHOD_CODES.has(code) && typeof rules[code] === 'string');
};

const formatStore = (store: any) => {
  const config = storeConfig(store.routingRules);
  const activeWebhook = Array.isArray(store.webhooks)
    ? store.webhooks.find((webhook: any) => webhook.status === 'active')
    : null;

  return {
    id: store.id,
    merchantId: store.merchantId,
    storeCode: store.storeCode,
    name: store.name,
    domain: store.domain ?? null,
    status: store.status,
    currency: store.currency,
    revenue: Number(store.revenue ?? 0),
    logoUrl: store.logoUrl ?? null,
    theme: store.theme ?? 'light',
    primaryColor: typeof config.primaryColor === 'string' ? config.primaryColor : null,
    successUrl: typeof config.successUrl === 'string' ? config.successUrl : null,
    webhookUrl: activeWebhook?.url ?? null,
    paymentMethods: paymentMethodsFromRouting(store.routingRules),
    routingConfigured: paymentMethodsFromRouting(store.routingRules).length > 0,
    createdAt: store.createdAt?.toISOString?.() ?? store.createdAt
  };
};

const generateStoreCode = async (name: string): Promise<string> => {
  const base = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'STORE';

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
    const candidate = `${base}-${suffix}`;
    const exists = await prisma.store.findUnique({ where: { storeCode: candidate }, select: { id: true } });
    if (!exists) return candidate;
  }

  return `${base}-${crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
};

export const getProfile = async (req: AuthRequest, res: Response) => {
  try {
    const merchantId = authorizeMerchantPath(req, res);
    if (!merchantId) return;

    const merchant = await prisma.merchant.findUnique({
      where: { id: merchantId },
      include: {
        stores: true,
        wallets: true
      }
    });

    if (!merchant) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Merchant não encontrado.' }
      });
    }

    return res.json({ success: true, data: merchant });
  } catch (error) {
    console.error('[MERCHANT_PROFILE_ERROR]', error);
    return res.status(500).json({ success: false, error: { message: 'Erro interno.' } });
  }
};

export const getStores = async (req: AuthRequest, res: Response) => {
  try {
    const merchantId = authorizeMerchantPath(req, res);
    if (!merchantId) return;

    const stores = await prisma.store.findMany({
      where: { merchantId },
      include: {
        webhooks: {
          select: { id: true, url: true, status: true, events: true, createdAt: true }
        }
      },
      orderBy: { createdAt: 'asc' }
    });

    return res.json({ success: true, data: stores.map(formatStore) });
  } catch (error) {
    console.error('[MERCHANT_STORES_ERROR]', error);
    return res.status(500).json({ success: false, error: { message: 'Erro interno.' } });
  }
};

export const createStore = async (req: AuthRequest, res: Response) => {
  try {
    const merchantId = authorizeMerchantPath(req, res);
    if (!merchantId) return;

    const name = String(req.body?.name ?? '').trim();
    if (name.length < 2 || name.length > 120) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_NAME', message: 'Nome da Store inválido.' }
      });
    }

    const currency = String(req.body?.currency ?? 'EUR').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_CURRENCY', message: 'Moeda inválida.' }
      });
    }

    const primaryColor = String(req.body?.primaryColor ?? '').trim();
    if (primaryColor && !/^#[0-9A-Fa-f]{6}$/.test(primaryColor)) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_COLOR', message: 'Cor principal inválida.' }
      });
    }

    const successUrlInput = String(req.body?.successUrl ?? '').trim();
    const successUrl = validOptionalUrl(successUrlInput);
    if (successUrlInput && !successUrl) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_SUCCESS_URL', message: 'URL de sucesso inválida.' }
      });
    }

    const webhookUrlInput = String(req.body?.webhookUrl ?? '').trim();
    const webhookUrl = validOptionalUrl(webhookUrlInput);
    if (webhookUrlInput && !webhookUrl) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_WEBHOOK_URL', message: 'URL de webhook inválida.' }
      });
    }

    const domain = String(req.body?.domain ?? '').trim() || null;
    const theme = String(req.body?.theme ?? 'light').toLowerCase() === 'dark' ? 'dark' : 'light';
    const logoUrlInput = String(req.body?.logoUrl ?? '').trim();
    const logoUrl = validOptionalUrl(logoUrlInput);
    if (logoUrlInput && !logoUrl) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_LOGO_URL', message: 'URL de logótipo inválida.' }
      });
    }

    const storeCode = await generateStoreCode(name);
    const config: Record<string, unknown> = {};
    if (primaryColor) config.primaryColor = primaryColor;
    if (successUrl) config.successUrl = successUrl;

    const created = await prisma.$transaction(async tx => {
      const store = await tx.store.create({
        data: {
          merchantId,
          storeCode,
          name,
          domain,
          status: 'draft',
          currency,
          routingRules: Object.keys(config).length ? { _config: config } : {},
          logoUrl,
          theme
        }
      });

      let webhookSecret: string | null = null;
      if (webhookUrl) {
        webhookSecret = `whsec_${crypto.randomBytes(24).toString('hex')}`;
        await tx.webhook.create({
          data: {
            storeId: store.id,
            url: webhookUrl,
            events: [
              'payment_intent.succeeded',
              'payment_intent.payment_failed',
              'payment_intent.processing',
              'payment_intent.canceled'
            ],
            status: 'active',
            secret: webhookSecret
          }
        });
      }

      return { store, webhookSecret };
    });

    const fullStore = await prisma.store.findUnique({
      where: { id: created.store.id },
      include: {
        webhooks: {
          select: { id: true, url: true, status: true, events: true, createdAt: true }
        }
      }
    });

    return res.status(201).json({
      success: true,
      data: {
        ...formatStore(fullStore),
        webhookSecret: created.webhookSecret
      },
      message: 'Store criada em draft. Configure routing/gateway e ative-a antes de aceitar pagamentos.'
    });
  } catch (error) {
    console.error('[MERCHANT_STORE_CREATE_ERROR]', error);
    return res.status(500).json({
      success: false,
      error: { code: 'STORE_CREATE_ERROR', message: 'Erro ao criar Store.' }
    });
  }
};

export const getStore = async (req: AuthRequest, res: Response) => {
  try {
    const merchantId = authorizeMerchantPath(req, res);
    if (!merchantId) return;

    const rawId = (req.params as any).id;
    const storeId = Array.isArray(rawId) ? String(rawId[0]) : String(rawId ?? '');

    const store = await prisma.store.findFirst({
      where: { id: storeId, merchantId },
      include: {
        apiKeys: {
          select: {
            id: true,
            name: true,
            scopes: true,
            environment: true,
            lastUsedAt: true,
            createdAt: true
          }
        },
        webhooks: {
          select: {
            id: true,
            url: true,
            events: true,
            status: true,
            successRate: true,
            lastDeliveryAt: true,
            createdAt: true
          }
        },
        gatewayVaults: {
          select: {
            id: true,
            provider: true,
            isActive: true,
            createdAt: true
          }
        }
      }
    });

    if (!store) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Loja não encontrada.' }
      });
    }

    return res.json({
      success: true,
      data: {
        ...formatStore(store),
        apiKeys: store.apiKeys,
        webhooks: store.webhooks,
        gatewayVaults: store.gatewayVaults
      }
    });
  } catch (error) {
    console.error('[MERCHANT_STORE_ERROR]', error);
    return res.status(500).json({ success: false, error: { message: 'Erro interno.' } });
  }
};
