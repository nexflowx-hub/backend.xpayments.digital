import crypto from 'crypto';
import { Response } from 'express';

import prisma from '../../../core/prisma';
import { AuthRequest } from '../../../middleware/auth.middleware';

const getMerchantId = (req: AuthRequest): string | null =>
  req.user?.id ? String(req.user.id) : null;

const getParamId = (value: string | string[]): string =>
  Array.isArray(value) ? value[0] : String(value);

const getMerchantStores = async (merchantId: string) =>
  prisma.store.findMany({
    where: {
      merchantId
    },
    select: {
      id: true,
      name: true,
      storeCode: true
    },
    orderBy: {
      name: 'asc'
    }
  });

const unauthorized = (res: Response) =>
  res.status(401).json({
    success: false,
    error: {
      code: 'UNAUTHORIZED',
      message: 'Merchant não autenticado.'
    }
  });

const formatApiKey = (apiKey: any) => ({
  id: apiKey.id,
  storeId: apiKey.storeId,
  storeName: apiKey.store.name,
  storeCode: apiKey.store.storeCode,
  name: apiKey.name,
  keyPreview: `${apiKey.key.slice(0, 12)}••••${apiKey.key.slice(-4)}`,
  scopes: apiKey.scopes,
  environment: apiKey.environment,
  lastUsedAt: apiKey.lastUsedAt?.toISOString() ?? null,
  createdAt: apiKey.createdAt.toISOString()
});

const formatWebhook = (webhook: any) => ({
  id: webhook.id,
  storeId: webhook.storeId,
  storeName: webhook.store.name,
  storeCode: webhook.store.storeCode,
  url: webhook.url,
  events: webhook.events ?? [],
  status: webhook.status,
  successRate: Number(webhook.successRate ?? 0),
  lastDeliveryAt:
    webhook.lastDeliveryAt?.toISOString() ?? null,
  lastDelivery:
    webhook.lastDeliveryAt?.toISOString() ?? null,
  createdAt: webhook.createdAt.toISOString()
});

export const getApiKeys = async (
  req: AuthRequest,
  res: Response
) => {
  try {
    const merchantId = getMerchantId(req);

    if (!merchantId) {
      return unauthorized(res);
    }

    const stores = await getMerchantStores(merchantId);

    const apiKeys = await prisma.apiKey.findMany({
      where: {
        storeId: {
          in: stores.map(store => store.id)
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
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    return res.status(200).json({
      success: true,
      data: apiKeys.map(formatApiKey)
    });
  } catch (error) {
    console.error('[API_KEYS_LIST_ERROR]', error);

    return res.status(500).json({
      success: false,
      error: {
        code: 'API_KEYS_ERROR',
        message: 'Erro ao carregar chaves de API.'
      }
    });
  }
};

export const createApiKey = async (
  req: AuthRequest,
  res: Response
) => {
  try {
    const merchantId = getMerchantId(req);

    if (!merchantId) {
      return unauthorized(res);
    }

    const storeId = String(req.body.storeId ?? '').trim();
    const name = String(req.body.name ?? '').trim();

    if (!storeId) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'STORE_REQUIRED',
          message: 'A Store é obrigatória.'
        }
      });
    }

    if (!name) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'NAME_REQUIRED',
          message: 'O nome da chave é obrigatório.'
        }
      });
    }

    const store = await prisma.store.findFirst({
      where: {
        id: storeId,
        merchantId
      },
      select: {
        id: true,
        name: true,
        storeCode: true
      }
    });

    if (!store) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'STORE_NOT_FOUND',
          message: 'Store não encontrada.'
        }
      });
    }

    const environment =
      String(req.body.environment ?? 'test').toLowerCase() ===
      'live'
        ? 'live'
        : 'test';

    const prefix =
      environment === 'live'
        ? 'xp_live_'
        : 'xp_test_';

    const fullKey = `${prefix}${crypto
      .randomBytes(24)
      .toString('hex')}`;

    const scopes = Array.isArray(req.body.scopes)
      ? req.body.scopes.map(String)
      : ['payments_write'];

    const apiKey = await prisma.apiKey.create({
      data: {
        storeId: store.id,
        name,
        key: fullKey,
        scopes,
        environment
      }
    });

    return res.status(201).json({
      success: true,
      data: {
        id: apiKey.id,
        storeId: store.id,
        storeName: store.name,
        storeCode: store.storeCode,
        name: apiKey.name,
        fullKey,
        keyPreview: `${fullKey.slice(0, 12)}••••${fullKey.slice(-4)}`,
        scopes: apiKey.scopes,
        environment: apiKey.environment,
        lastUsedAt: null,
        createdAt: apiKey.createdAt.toISOString()
      }
    });
  } catch (error) {
    console.error('[API_KEY_CREATE_ERROR]', error);

    return res.status(500).json({
      success: false,
      error: {
        code: 'API_KEY_CREATE_ERROR',
        message: 'Erro ao gerar chave de API.'
      }
    });
  }
};

export const deleteApiKey = async (
  req: AuthRequest,
  res: Response
) => {
  try {
    const merchantId = getMerchantId(req);

    if (!merchantId) {
      return unauthorized(res);
    }

    const apiKeyId = getParamId(req.params.id);
    const stores = await getMerchantStores(merchantId);

    const result = await prisma.apiKey.deleteMany({
      where: {
        id: apiKeyId,
        storeId: {
          in: stores.map(store => store.id)
        }
      }
    });

    if (result.count === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Chave de API não encontrada.'
        }
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        deleted: true,
        id: apiKeyId
      }
    });
  } catch (error) {
    console.error('[API_KEY_DELETE_ERROR]', error);

    return res.status(500).json({
      success: false,
      error: {
        code: 'API_KEY_DELETE_ERROR',
        message: 'Erro ao revogar chave de API.'
      }
    });
  }
};

export const getWebhooks = async (
  req: AuthRequest,
  res: Response
) => {
  try {
    const merchantId = getMerchantId(req);

    if (!merchantId) {
      return unauthorized(res);
    }

    const stores = await getMerchantStores(merchantId);

    const webhooks = await prisma.webhook.findMany({
      where: {
        storeId: {
          in: stores.map(store => store.id)
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
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    return res.status(200).json({
      success: true,
      data: webhooks.map(formatWebhook)
    });
  } catch (error) {
    console.error('[WEBHOOKS_LIST_ERROR]', error);

    return res.status(500).json({
      success: false,
      error: {
        code: 'WEBHOOKS_ERROR',
        message: 'Erro ao carregar webhooks.'
      }
    });
  }
};

export const createWebhook = async (
  req: AuthRequest,
  res: Response
) => {
  try {
    const merchantId = getMerchantId(req);

    if (!merchantId) {
      return unauthorized(res);
    }

    const storeId = String(req.body.storeId ?? '').trim();
    const url = String(req.body.url ?? '').trim();

    if (!storeId) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'STORE_REQUIRED',
          message: 'A Store é obrigatória.'
        }
      });
    }

    if (!url) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'URL_REQUIRED',
          message: 'A URL do webhook é obrigatória.'
        }
      });
    }

    try {
      new URL(url);
    } catch {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_URL',
          message: 'URL do webhook inválida.'
        }
      });
    }

    const store = await prisma.store.findFirst({
      where: {
        id: storeId,
        merchantId
      },
      select: {
        id: true,
        name: true,
        storeCode: true
      }
    });

    if (!store) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'STORE_NOT_FOUND',
          message: 'Store não encontrada.'
        }
      });
    }

    const events = Array.isArray(req.body.events)
      ? req.body.events.map(String)
      : [];

    const webhook = await prisma.webhook.create({
      data: {
        storeId: store.id,
        url,
        events,
        status: 'active',
        secret: `whsec_${crypto
          .randomBytes(24)
          .toString('hex')}`
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

    return res.status(201).json({
      success: true,
      data: {
        ...formatWebhook(webhook),
        secret: webhook.secret
      }
    });
  } catch (error) {
    console.error('[WEBHOOK_CREATE_ERROR]', error);

    return res.status(500).json({
      success: false,
      error: {
        code: 'WEBHOOK_CREATE_ERROR',
        message: 'Erro ao criar webhook.'
      }
    });
  }
};

export const updateWebhook = async (
  req: AuthRequest,
  res: Response
) => {
  try {
    const merchantId = getMerchantId(req);

    if (!merchantId) {
      return unauthorized(res);
    }

    const webhookId = getParamId(req.params.id);

    const currentWebhook = await prisma.webhook.findFirst({
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

    if (!currentWebhook) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Webhook não encontrado.'
        }
      });
    }

    const url =
      req.body.url === undefined
        ? currentWebhook.url
        : String(req.body.url).trim();

    if (!url) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'URL_REQUIRED',
          message: 'A URL do webhook é obrigatória.'
        }
      });
    }

    try {
      new URL(url);
    } catch {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_URL',
          message: 'URL do webhook inválida.'
        }
      });
    }

    const events =
      req.body.events === undefined
        ? currentWebhook.events
        : Array.isArray(req.body.events)
          ? req.body.events.map(String)
          : null;

    if (events === null) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_EVENTS',
          message: 'O campo events deve ser um array.'
        }
      });
    }

    const requestedStatus =
      req.body.status === undefined
        ? currentWebhook.status
        : String(req.body.status).toLowerCase();

    const allowedStatuses = [
      'active',
      'paused',
      'inactive',
      'disabled'
    ];

    if (!allowedStatuses.includes(requestedStatus)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_STATUS',
          message: 'Status de webhook inválido.'
        }
      });
    }

    let storeId = currentWebhook.storeId;

    if (req.body.storeId !== undefined) {
      const requestedStoreId = String(
        req.body.storeId
      ).trim();

      const requestedStore = await prisma.store.findFirst({
        where: {
          id: requestedStoreId,
          merchantId
        },
        select: {
          id: true
        }
      });

      if (!requestedStore) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'STORE_NOT_FOUND',
            message: 'Store não encontrada.'
          }
        });
      }

      storeId = requestedStore.id;
    }

    const updatedWebhook = await prisma.webhook.update({
      where: {
        id: webhookId
      },
      data: {
        storeId,
        url,
        events,
        status: requestedStatus
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

    return res.status(200).json({
      success: true,
      data: formatWebhook(updatedWebhook),
      message: 'Webhook atualizado com sucesso.'
    });
  } catch (error) {
    console.error('[WEBHOOK_UPDATE_ERROR]', error);

    return res.status(500).json({
      success: false,
      error: {
        code: 'WEBHOOK_UPDATE_ERROR',
        message: 'Erro ao atualizar webhook.'
      }
    });
  }
};

export const deleteWebhook = async (
  req: AuthRequest,
  res: Response
) => {
  try {
    const merchantId = getMerchantId(req);

    if (!merchantId) {
      return unauthorized(res);
    }

    const webhookId = getParamId(req.params.id);
    const stores = await getMerchantStores(merchantId);

    const result = await prisma.webhook.deleteMany({
      where: {
        id: webhookId,
        storeId: {
          in: stores.map(store => store.id)
        }
      }
    });

    if (result.count === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Webhook não encontrado.'
        }
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        deleted: true,
        id: webhookId
      }
    });
  } catch (error) {
    console.error('[WEBHOOK_DELETE_ERROR]', error);

    return res.status(500).json({
      success: false,
      error: {
        code: 'WEBHOOK_DELETE_ERROR',
        message: 'Erro ao remover webhook.'
      }
    });
  }
};
