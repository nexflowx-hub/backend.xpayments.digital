import crypto from 'crypto';
import { Response } from 'express';

import prisma from '../../../core/prisma';
import { AuthRequest } from '../../../middleware/auth.middleware';

const getMerchantId = (req: AuthRequest): string | null =>
  req.user?.id ? String(req.user.id) : null;

const getParamId = (value: string | string[]): string =>
  Array.isArray(value) ? value[0] : String(value);

const unauthorized = (res: Response) =>
  res.status(401).json({
    success: false,
    error: {
      code: 'UNAUTHORIZED',
      message: 'Merchant não autenticado.'
    }
  });

const notFound = (res: Response, resource: 'api key' | 'webhook') =>
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: resource === 'api key'
        ? 'Chave de API não encontrada.'
        : 'Webhook não encontrado.'
    }
  });

const requireConfirmation = (req: AuthRequest, res: Response): boolean => {
  if (req.body?.confirm === true) return true;

  res.status(400).json({
    success: false,
    error: {
      code: 'CONFIRMATION_REQUIRED',
      message: 'Confirme explicitamente a rotação com confirm=true.'
    }
  });

  return false;
};

const protectSecretResponse = (res: Response) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
};

const logSecretOperation = (
  operation: string,
  merchantId: string,
  resourceId: string
) => {
  console.info('[DEVELOPER_SECRET_OPERATION]', {
    operation,
    merchantId,
    resourceId
  });
};

export const revealApiKey = async (req: AuthRequest, res: Response) => {
  try {
    const merchantId = getMerchantId(req);
    if (!merchantId) return unauthorized(res);

    const apiKeyId = getParamId(req.params.id);

    const apiKey = await prisma.apiKey.findFirst({
      where: {
        id: apiKeyId,
        store: {
          merchantId
        }
      },
      include: {
        store: {
          select: {
            id: true,
            name: true,
            storeCode: true
          }
        }
      }
    });

    if (!apiKey) return notFound(res, 'api key');

    protectSecretResponse(res);
    logSecretOperation('api_key_reveal', merchantId, apiKey.id);

    return res.status(200).json({
      success: true,
      data: {
        id: apiKey.id,
        storeId: apiKey.storeId,
        storeName: apiKey.store.name,
        storeCode: apiKey.store.storeCode,
        name: apiKey.name,
        environment: apiKey.environment,
        scopes: apiKey.scopes,
        fullKey: apiKey.key,
        keyPreview: `${apiKey.key.slice(0, 12)}••••${apiKey.key.slice(-4)}`,
        lastUsedAt: apiKey.lastUsedAt?.toISOString() ?? null,
        createdAt: apiKey.createdAt.toISOString()
      }
    });
  } catch (error) {
    console.error('[API_KEY_REVEAL_ERROR]', error);

    return res.status(500).json({
      success: false,
      error: {
        code: 'API_KEY_REVEAL_ERROR',
        message: 'Erro ao revelar chave de API.'
      }
    });
  }
};

export const rotateApiKey = async (req: AuthRequest, res: Response) => {
  try {
    const merchantId = getMerchantId(req);
    if (!merchantId) return unauthorized(res);
    if (!requireConfirmation(req, res)) return;

    const apiKeyId = getParamId(req.params.id);

    const current = await prisma.apiKey.findFirst({
      where: {
        id: apiKeyId,
        store: {
          merchantId
        }
      },
      include: {
        store: {
          select: {
            id: true,
            name: true,
            storeCode: true
          }
        }
      }
    });

    if (!current) return notFound(res, 'api key');

    const prefix = current.environment === 'live' ? 'xp_live_' : 'xp_test_';
    const fullKey = `${prefix}${crypto.randomBytes(24).toString('hex')}`;

    const rotated = await prisma.apiKey.update({
      where: { id: current.id },
      data: {
        key: fullKey,
        lastUsedAt: null
      }
    });

    protectSecretResponse(res);
    logSecretOperation('api_key_rotate', merchantId, rotated.id);

    return res.status(200).json({
      success: true,
      data: {
        id: rotated.id,
        storeId: current.storeId,
        storeName: current.store.name,
        storeCode: current.store.storeCode,
        name: rotated.name,
        environment: rotated.environment,
        scopes: rotated.scopes,
        fullKey,
        keyPreview: `${fullKey.slice(0, 12)}••••${fullKey.slice(-4)}`,
        lastUsedAt: null,
        createdAt: rotated.createdAt.toISOString()
      },
      message: 'API key rodada. A chave anterior deixou de ser válida imediatamente.'
    });
  } catch (error) {
    console.error('[API_KEY_ROTATE_ERROR]', error);

    return res.status(500).json({
      success: false,
      error: {
        code: 'API_KEY_ROTATE_ERROR',
        message: 'Erro ao rodar chave de API.'
      }
    });
  }
};

export const revealWebhookSecret = async (req: AuthRequest, res: Response) => {
  try {
    const merchantId = getMerchantId(req);
    if (!merchantId) return unauthorized(res);

    const webhookId = getParamId(req.params.id);

    const webhook = await prisma.webhook.findFirst({
      where: {
        id: webhookId,
        store: {
          merchantId
        }
      },
      include: {
        store: {
          select: {
            id: true,
            name: true,
            storeCode: true
          }
        }
      }
    });

    if (!webhook) return notFound(res, 'webhook');

    if (!webhook.secret) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'WEBHOOK_SECRET_NOT_CONFIGURED',
          message: 'Este webhook não possui signing secret configurado.'
        }
      });
    }

    protectSecretResponse(res);
    logSecretOperation('webhook_secret_reveal', merchantId, webhook.id);

    return res.status(200).json({
      success: true,
      data: {
        id: webhook.id,
        storeId: webhook.storeId,
        storeName: webhook.store.name,
        storeCode: webhook.store.storeCode,
        url: webhook.url,
        secret: webhook.secret,
        secretPreview: `${webhook.secret.slice(0, 10)}••••${webhook.secret.slice(-4)}`
      }
    });
  } catch (error) {
    console.error('[WEBHOOK_SECRET_REVEAL_ERROR]', error);

    return res.status(500).json({
      success: false,
      error: {
        code: 'WEBHOOK_SECRET_REVEAL_ERROR',
        message: 'Erro ao revelar signing secret.'
      }
    });
  }
};

export const rotateWebhookSecret = async (req: AuthRequest, res: Response) => {
  try {
    const merchantId = getMerchantId(req);
    if (!merchantId) return unauthorized(res);
    if (!requireConfirmation(req, res)) return;

    const webhookId = getParamId(req.params.id);

    const current = await prisma.webhook.findFirst({
      where: {
        id: webhookId,
        store: {
          merchantId
        }
      },
      include: {
        store: {
          select: {
            id: true,
            name: true,
            storeCode: true
          }
        }
      }
    });

    if (!current) return notFound(res, 'webhook');

    const secret = `whsec_${crypto.randomBytes(24).toString('hex')}`;

    const rotated = await prisma.webhook.update({
      where: { id: current.id },
      data: { secret }
    });

    protectSecretResponse(res);
    logSecretOperation('webhook_secret_rotate', merchantId, rotated.id);

    return res.status(200).json({
      success: true,
      data: {
        id: rotated.id,
        storeId: current.storeId,
        storeName: current.store.name,
        storeCode: current.store.storeCode,
        url: current.url,
        secret,
        secretPreview: `${secret.slice(0, 10)}••••${secret.slice(-4)}`
      },
      message: 'Signing secret rodado. O secret anterior deixou de ser válido imediatamente.'
    });
  } catch (error) {
    console.error('[WEBHOOK_SECRET_ROTATE_ERROR]', error);

    return res.status(500).json({
      success: false,
      error: {
        code: 'WEBHOOK_SECRET_ROTATE_ERROR',
        message: 'Erro ao rodar signing secret.'
      }
    });
  }
};
