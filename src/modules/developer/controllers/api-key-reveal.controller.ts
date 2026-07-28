import { Response } from 'express';

import prisma from '../../../core/prisma';
import { AuthRequest } from '../../../middleware/auth.middleware';

const REVEAL_WINDOW_MS = 60_000;
const REVEAL_MAX_ATTEMPTS = 5;

const revealAttempts = new Map<
  string,
  {
    count: number;
    windowStartedAt: number;
  }
>();

const getParamId = (
  value: string | string[]
): string =>
  Array.isArray(value)
    ? value[0]
    : String(value);

const consumeRevealAttempt = (
  key: string
): {
  allowed: boolean;
  retryAfterSeconds: number;
} => {
  const now = Date.now();
  const current = revealAttempts.get(key);

  if (
    !current ||
    now - current.windowStartedAt >=
      REVEAL_WINDOW_MS
  ) {
    revealAttempts.set(key, {
      count: 1,
      windowStartedAt: now
    });

    return {
      allowed: true,
      retryAfterSeconds: 0
    };
  }

  if (current.count >= REVEAL_MAX_ATTEMPTS) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil(
          (
            REVEAL_WINDOW_MS -
            (now - current.windowStartedAt)
          ) / 1000
        )
      )
    };
  }

  current.count += 1;
  revealAttempts.set(key, current);

  return {
    allowed: true,
    retryAfterSeconds: 0
  };
};

export const revealApiKey = async (
  req: AuthRequest,
  res: Response
) => {
  res.setHeader(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, private'
  );
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const merchantId =
    req.merchantId || req.user?.id;

  if (!merchantId) {
    return res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Merchant não autenticado.'
      }
    });
  }

  const apiKeyId = getParamId(
    req.params.id
  );

  const rateLimitKey = [
    String(merchantId),
    apiKeyId,
    req.ip || 'unknown'
  ].join(':');

  const rateLimit =
    consumeRevealAttempt(rateLimitKey);

  if (!rateLimit.allowed) {
    res.setHeader(
      'Retry-After',
      String(rateLimit.retryAfterSeconds)
    );

    console.warn(
      '[API_KEY_REVEAL_RATE_LIMITED]',
      {
        merchantId: String(merchantId),
        apiKeyId,
        ip: req.ip || null,
        retryAfterSeconds:
          rateLimit.retryAfterSeconds,
        limitedAt:
          new Date().toISOString()
      }
    );

    return res.status(429).json({
      success: false,
      error: {
        code: 'API_KEY_REVEAL_RATE_LIMITED',
        message:
          'Muitas tentativas de visualização. Tente novamente dentro de instantes.'
      }
    });
  }

  try {
    const apiKey =
      await prisma.apiKey.findFirst({
        where: {
          id: apiKeyId,
          store: {
            merchantId: String(merchantId)
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

    if (!apiKey) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'API_KEY_NOT_FOUND',
          message:
            'Chave de API não encontrada.'
        }
      });
    }

    console.log(
      '[API_KEY_REVEALED]',
      {
        merchantId:
          String(merchantId),
        apiKeyId:
          apiKey.id,
        storeId:
          apiKey.store.id,
        storeCode:
          apiKey.store.storeCode,
        ip: req.ip || null,
        userAgent:
          req.get('user-agent') || null,
        revealedAt:
          new Date().toISOString()
      }
    );

    return res.status(200).json({
      success: true,
      data: {
        id: apiKey.id,
        storeId: apiKey.store.id,
        storeName: apiKey.store.name,
        storeCode:
          apiKey.store.storeCode,
        name: apiKey.name,
        environment:
          apiKey.environment,
        scopes: apiKey.scopes,
        fullKey: apiKey.key
      }
    });
  } catch (error) {
    console.error(
      '[API_KEY_REVEAL_ERROR]',
      error
    );

    return res.status(500).json({
      success: false,
      error: {
        code: 'API_KEY_REVEAL_ERROR',
        message:
          'Erro ao visualizar a chave de API.'
      }
    });
  }
};
