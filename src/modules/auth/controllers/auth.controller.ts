import { Request, Response } from 'express';
import prisma from '../../../core/prisma';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_xpayments_digital_2026_master_key';
const DEFAULT_SHARED_SANDBOX_SOURCE_VAULT_ID = 'c9e9e4b2-bbf1-458a-b643-84fb48a8ffb8';
interface AuthRequest extends Request { user?: any; }

interface SharedSandboxConfig {
  sourceVaultId: string;
  secretKey: string;
  publishableKey: string;
  webhookSecret: string;
  stripeAccountId: string;
  webhookEndpointId?: string;
  webhookUrl: string;
}

const objectValue = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }

  return {};
};

const getSharedSandboxConfig = async (): Promise<SharedSandboxConfig | null> => {
  const sourceVaultId = String(
    process.env.XPAYMENTS_SANDBOX_SOURCE_VAULT_ID || DEFAULT_SHARED_SANDBOX_SOURCE_VAULT_ID
  ).trim();

  if (!sourceVaultId) return null;

  const sourceVault = await prisma.gatewayVault.findFirst({
    where: {
      id: sourceVaultId,
      isActive: true
    },
    select: {
      id: true,
      provider: true,
      credentials: true
    }
  });

  if (!sourceVault || !sourceVault.provider.startsWith('stripe-')) {
    return null;
  }

  const sourceCredentials = objectValue(sourceVault.credentials);
  const secretKey = String(sourceCredentials.secretKey || '').trim();
  const publishableKey = String(sourceCredentials.publishableKey || '').trim();
  const webhookSecret = String(sourceCredentials.webhookSecret || '').trim();
  const stripeAccountId = String(sourceCredentials.stripeAccountId || '').trim();
  const webhookEndpointId = String(sourceCredentials.webhookEndpointId || '').trim() || undefined;
  const webhookUrl = String(
    sourceCredentials.webhookUrl || 'https://api.xpayments.digital/api/v1/payments/webhooks/stripe'
  ).trim();
  const environment = String(sourceCredentials.environment || '').trim().toLowerCase();
  const processingMode = String(sourceCredentials.processingMode || '').trim().toUpperCase();

  if (
    !secretKey.startsWith('sk_test_') ||
    !publishableKey.startsWith('pk_test_') ||
    !webhookSecret.startsWith('whsec_') ||
    !stripeAccountId.startsWith('acct_') ||
    environment !== 'test' ||
    processingMode !== 'ORCHESTRATED' ||
    !/^https:\/\//i.test(webhookUrl)
  ) {
    return null;
  }

  return {
    sourceVaultId: sourceVault.id,
    secretKey,
    publishableKey,
    webhookSecret,
    stripeAccountId,
    webhookEndpointId,
    webhookUrl
  };
};

const createTestApiKey = (): string =>
  `xp_test_${crypto.randomBytes(24).toString('hex')}`;

export const login = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    const merchant = await prisma.merchant.findUnique({ where: { email } });

    if (!merchant || !(await bcrypt.compare(password, merchant.passwordHash))) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Credenciais inválidas' } });
    }

    const token = jwt.sign({ id: merchant.id, role: 'merchant' }, JWT_SECRET, { expiresIn: '24h' });

    res.status(200).json({
      success: true,
      data: {
        token,
        merchant: {
          id: merchant.id,
          name: merchant.name,
          email: merchant.email
        }
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
};

export const register = async (req: Request, res: Response) => {
  try {
    const { email, password, name, companyName } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'Faltam dados obrigatórios.' } });
    }

    const existingMerchant = await prisma.merchant.findUnique({ where: { email } });
    if (existingMerchant) {
      return res.status(400).json({ success: false, error: { code: 'CONFLICT', message: 'Este email já está registado.' } });
    }

    const sharedSandbox = await getSharedSandboxConfig();
    if (!sharedSandbox) {
      return res.status(503).json({
        success: false,
        error: {
          code: 'SANDBOX_PROVISIONING_UNAVAILABLE',
          message: 'O ambiente Sandbox está temporariamente indisponível para novos registos.'
        }
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const testApiKey = createTestApiKey();

    const provisioned = await prisma.$transaction(async (tx) => {
      const newMerchant = await tx.merchant.create({
        data: {
          email,
          name,
          company: companyName || '',
          passwordHash,
          status: 'active',
          kycStatus: 'not_submitted'
        }
      });

      await tx.wallet.create({
        data: {
          merchantId: newMerchant.id,
          currency: 'EUR',
          label: 'Conta Principal (EUR)',
          type: 'fiat'
        }
      });

      const suffix = newMerchant.id.replace(/-/g, '').slice(0, 12).toUpperCase();
      const storeCode = `XPAY-SANDBOX-${suffix}`;
      const providerAlias = `stripe-xpay-sandbox-${suffix.toLowerCase()}`;

      const store = await tx.store.create({
        data: {
          merchantId: newMerchant.id,
          storeCode,
          name: 'XPAY Sandbox',
          status: 'active',
          currency: 'EUR',
          theme: 'light',
          routingRules: {
            card: providerAlias,
            mb_way: providerAlias,
            multibanco: providerAlias,
            bizum: providerAlias
          }
        }
      });

      const credentials: any = {
        secretKey: sharedSandbox.secretKey,
        publishableKey: sharedSandbox.publishableKey,
        webhookSecret: sharedSandbox.webhookSecret,
        stripeAccountId: sharedSandbox.stripeAccountId,
        webhookUrl: sharedSandbox.webhookUrl,
        environment: 'test',
        credentialMode: 'xpayments_managed',
        credentialState: 'VALIDATED',
        processingMode: 'ORCHESTRATED',
        sourceStore: storeCode,
        sharedSandboxSourceVaultId: sharedSandbox.sourceVaultId,
        systemWebhook: {
          configured: true,
          source: 'XPAYMENTS_ORCHESTRATED_STANDARD_SANDBOX',
          configuredAt: new Date().toISOString()
        }
      };

      if (sharedSandbox.webhookEndpointId) {
        credentials.webhookEndpointId = sharedSandbox.webhookEndpointId;
      }

      const gatewayVault = await tx.gatewayVault.create({
        data: {
          merchantId: newMerchant.id,
          storeId: store.id,
          provider: providerAlias,
          isActive: true,
          credentials
        }
      });

      const apiKey = await tx.apiKey.create({
        data: {
          storeId: store.id,
          name: 'XPAY Sandbox — Test API Key',
          key: testApiKey,
          environment: 'test',
          scopes: ['payments_write']
        }
      });

      return { merchant: newMerchant, store, gatewayVault, apiKey };
    });

    const token = jwt.sign({ id: provisioned.merchant.id, role: 'merchant' }, JWT_SECRET, { expiresIn: '24h' });

    res.status(201).json({
      success: true,
      data: {
        token,
        merchant: {
          id: provisioned.merchant.id,
          name: provisioned.merchant.name,
          email: provisioned.merchant.email
        },
        onboarding: {
          status: 'ready',
          environment: 'test',
          storeId: provisioned.store.id,
          storeCode: provisioned.store.storeCode,
          storeName: provisioned.store.name,
          apiKeyId: provisioned.apiKey.id,
          apiKeyPrefix: testApiKey.slice(0, 13),
          gatewayVaultId: provisioned.gatewayVault.id,
          currency: provisioned.store.currency
        }
      }
    });
  } catch (error: any) {
    console.error('[auth.register]', {
      code: error?.code || null,
      message: error?.message || 'Unknown registration error'
    });
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Não foi possível concluir o registo.' } });
  }
};

export const me = async (req: AuthRequest, res: Response) => {
  try {
    const merchant = await prisma.merchant.findUnique({ where: { id: req.user.id } });
    if (!merchant) return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Comerciante não encontrado.' } });

    res.status(200).json({
      success: true,
      data: {
        merchant: {
          id: merchant.id,
          name: merchant.name,
          email: merchant.email
        }
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
};

export const logout = (req: Request, res: Response) => res.status(200).json({ success: true, data: { message: 'Sessão terminada.' } });
