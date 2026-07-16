import crypto from 'crypto';
import { Request, Response } from 'express';

import {
  sendXpIAChat,
  XpIAContext,
  XpIAMessage
} from '../services/openrouter.service';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();

const MAX_MESSAGES = 20;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_TOTAL_CHARACTERS = 16000;

const getRateLimit = (): number => {
  const parsed = Number(
    process.env.XPIA_RATE_LIMIT_PER_MINUTE
  );

  if (!Number.isFinite(parsed)) {
    return 10;
  }

  return Math.min(60, Math.max(1, parsed));
};

const getClientIdentifier = (req: Request): string => {
  const forwardedFor = req.headers['x-forwarded-for'];

  const forwardedIp =
    typeof forwardedFor === 'string'
      ? forwardedFor.split(',')[0].trim()
      : Array.isArray(forwardedFor)
        ? forwardedFor[0]
        : null;

  const merchantId = (req as any).user?.id;

  return merchantId
    ? `merchant:${merchantId}`
    : `ip:${forwardedIp || req.ip || 'unknown'}`;
};

const checkRateLimit = (
  identifier: string
): {
  allowed: boolean;
  remaining: number;
  resetAt: number;
} => {
  const now = Date.now();
  const limit = getRateLimit();

  const current = rateLimitStore.get(identifier);

  if (!current || current.resetAt <= now) {
    const resetAt = now + 60000;

    rateLimitStore.set(identifier, {
      count: 1,
      resetAt
    });

    return {
      allowed: true,
      remaining: limit - 1,
      resetAt
    };
  }

  if (current.count >= limit) {
    return {
      allowed: false,
      remaining: 0,
      resetAt: current.resetAt
    };
  }

  current.count += 1;
  rateLimitStore.set(identifier, current);

  return {
    allowed: true,
    remaining: Math.max(0, limit - current.count),
    resetAt: current.resetAt
  };
};

const validateMessages = (
  value: unknown
):
  | {
      valid: true;
      messages: XpIAMessage[];
    }
  | {
      valid: false;
      message: string;
    } => {
  if (!Array.isArray(value)) {
    return {
      valid: false,
      message: 'O campo messages deve ser um array.'
    };
  }

  if (value.length === 0) {
    return {
      valid: false,
      message: 'Envie pelo menos uma mensagem.'
    };
  }

  if (value.length > MAX_MESSAGES) {
    return {
      valid: false,
      message: `O histórico não pode ultrapassar ${MAX_MESSAGES} mensagens.`
    };
  }

  const messages: XpIAMessage[] = [];
  let totalCharacters = 0;

  for (const item of value) {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item)
    ) {
      return {
        valid: false,
        message: 'Formato de mensagem inválido.'
      };
    }

    const role = String((item as any).role || '');
    const content = String((item as any).content || '').trim();

    if (role !== 'user' && role !== 'assistant') {
      return {
        valid: false,
        message:
          'Apenas mensagens user e assistant são permitidas.'
      };
    }

    if (!content) {
      return {
        valid: false,
        message: 'O conteúdo da mensagem é obrigatório.'
      };
    }

    if (content.length > MAX_MESSAGE_LENGTH) {
      return {
        valid: false,
        message: `Cada mensagem pode ter no máximo ${MAX_MESSAGE_LENGTH} caracteres.`
      };
    }

    totalCharacters += content.length;

    if (totalCharacters > MAX_TOTAL_CHARACTERS) {
      return {
        valid: false,
        message: `O histórico pode ter no máximo ${MAX_TOTAL_CHARACTERS} caracteres.`
      };
    }

    messages.push({
      role,
      content
    } as XpIAMessage);
  }

  if (messages[messages.length - 1].role !== 'user') {
    return {
      valid: false,
      message:
        'A última mensagem do histórico deve ser do utilizador.'
    };
  }

  return {
    valid: true,
    messages
  };
};

const normalizeContext = (
  value: unknown,
  merchantAuthenticated: boolean
): XpIAContext => {
  if (!value || typeof value !== 'object') {
    return {
      merchantAuthenticated
    };
  }

  const context = value as Record<string, unknown>;

  return {
    page:
      typeof context.page === 'string'
        ? context.page.slice(0, 200)
        : undefined,

    storeId:
      typeof context.storeId === 'string'
        ? context.storeId.slice(0, 100)
        : null,

    storeCode:
      typeof context.storeCode === 'string'
        ? context.storeCode.slice(0, 100)
        : null,

    merchantAuthenticated
  };
};

export const chat = async (
  req: Request,
  res: Response
) => {
  try {
    if (
      String(process.env.XPIA_ENABLED || 'true').toLowerCase() !==
      'true'
    ) {
      return res.status(503).json({
        success: false,
        error: {
          code: 'XPIA_DISABLED',
          message:
            'A XpIA está temporariamente indisponível.'
        }
      });
    }

    const identifier = getClientIdentifier(req);
    const rateLimit = checkRateLimit(identifier);

    res.setHeader(
      'X-RateLimit-Remaining',
      String(rateLimit.remaining)
    );

    res.setHeader(
      'X-RateLimit-Reset',
      String(Math.ceil(rateLimit.resetAt / 1000))
    );

    if (!rateLimit.allowed) {
      return res.status(429).json({
        success: false,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message:
            'Foram enviadas demasiadas mensagens. Tente novamente dentro de alguns instantes.'
        }
      });
    }

    const validation = validateMessages(req.body?.messages);

    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_MESSAGES',
          message: validation.message
        }
      });
    }

    const locale =
      typeof req.body?.locale === 'string'
        ? req.body.locale.slice(0, 20)
        : undefined;

    const merchantId = (req as any).user?.id;

    const context = normalizeContext(
      req.body?.context,
      Boolean(merchantId)
    );

    const result = await sendXpIAChat({
      messages: validation.messages,
      locale,
      context,
      userIdentifier: crypto
        .createHash('sha256')
        .update(identifier)
        .digest('hex')
    });

    return res.status(200).json({
      success: true,

      data: {
        response: result.response,
        messageId:
          result.requestId ||
          crypto.randomUUID(),
        model: result.model,
        finishReason: result.finishReason,

        usage: {
          promptTokens: result.usage.promptTokens,
          completionTokens:
            result.usage.completionTokens,
          totalTokens: result.usage.totalTokens
        }
      }
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Erro desconhecido na XpIA.';

    console.error('[XPIA_CHAT_ERROR]', message);

    return res.status(502).json({
      success: false,

      error: {
        code: 'XPIA_PROVIDER_ERROR',
        message:
          'A XpIA está temporariamente indisponível. Tente novamente ou utilize os canais de suporte.'
      },

      support: {
        telegram: '@XPayments_Manager',
        email: 'contact@xpayments.digital',
        whatsapp: '+55 62 99288-7416'
      }
    });
  }
};

export const status = async (
  req: Request,
  res: Response
) => {
  const enabled =
    String(process.env.XPIA_ENABLED || 'true').toLowerCase() ===
    'true';

  const configured = Boolean(
    process.env.OPENROUTER_API_KEY &&
    process.env.OPENROUTER_MODEL
  );

  return res.status(200).json({
    success: true,

    data: {
      name: 'XpIA',
      enabled,
      configured,
      available: enabled && configured
    }
  });
};
