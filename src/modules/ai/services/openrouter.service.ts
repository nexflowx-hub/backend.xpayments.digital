import { XPIA_SYSTEM_PROMPT } from '../prompts/xpia.system-prompt';

export type XpIARole = 'user' | 'assistant';

export interface XpIAMessage {
  role: XpIARole;
  content: string;
}

export interface XpIAContext {
  page?: string;
  storeId?: string | null;
  storeCode?: string | null;
  merchantAuthenticated?: boolean;
}

export interface XpIAChatInput {
  messages: XpIAMessage[];
  locale?: string;
  context?: XpIAContext;
  userIdentifier?: string;
}

interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
}

interface OpenRouterChoice {
  finish_reason?: string | null;
  native_finish_reason?: string | null;

  message?: {
    role?: string;
    content?: string | null;
    refusal?: string | null;
  };

  error?: {
    code?: number | string;
    message?: string;
  };
}

interface OpenRouterResponse {
  id?: string;
  model?: string;
  provider?: string;
  choices?: OpenRouterChoice[];
  usage?: OpenRouterUsage;

  error?: {
    code?: number | string;
    message?: string;
    metadata?: {
      raw?: string;
      provider_name?: string;
      is_byok?: boolean;
      [key: string]: unknown;
    };
  };
}

export interface XpIAChatResult {
  response: string;
  model: string;
  requestId: string | null;
  finishReason: string | null;

  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cost: number | null;
  };
}

const OPENROUTER_URL =
  'https://openrouter.ai/api/v1/chat/completions';

const getNumberEnv = (
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number => {
  const parsed = Number(process.env[name]);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, parsed));
};

const getModels = (): string[] => {
  const primary =
    process.env.OPENROUTER_MODEL?.trim();

  const fallbacks = String(
    process.env.OPENROUTER_FALLBACK_MODELS || ''
  )
    .split(',')
    .map(model => model.trim())
    .filter(Boolean);

  return Array.from(
    new Set([primary, ...fallbacks].filter(Boolean) as string[])
  );
};

const buildSessionContext = (
  locale?: string,
  context?: XpIAContext
): string =>
  [
    '',
    '',
    'CONTEXTO AUTORIZADO DA SESSÃO',
    `Idioma solicitado: ${locale || 'detetar automaticamente'}`,
    `Página atual: ${context?.page || 'não informada'}`,
    `Store ID: ${context?.storeId || 'não informado'}`,
    `Store Code: ${context?.storeCode || 'não informado'}`,
    `Merchant autenticado: ${
      context?.merchantAuthenticated ? 'sim' : 'não'
    }`,
    '',
    'Utilize este contexto apenas quando for relevante.',
    'Não invente dados que não tenham sido informados.'
  ].join('\n');

const buildSystemPrompt = (
  locale?: string,
  context?: XpIAContext
): string =>
  `${XPIA_SYSTEM_PROMPT}${buildSessionContext(
    locale,
    context
  )}`;

const parseResponse = (
  rawText: string,
  status: number
): OpenRouterResponse => {
  if (!rawText.trim()) {
    throw new Error(
      `OpenRouter devolveu resposta vazia. HTTP ${status}.`
    );
  }

  try {
    return JSON.parse(rawText) as OpenRouterResponse;
  } catch {
    console.error(
      '[OPENROUTER_INVALID_JSON]',
      rawText.slice(0, 2000)
    );

    throw new Error(
      `OpenRouter devolveu resposta inválida. HTTP ${status}.`
    );
  }
};

const providerMessage = (
  data: OpenRouterResponse,
  status: number
): string =>
  data.error?.metadata?.raw ||
  data.error?.message ||
  data.choices?.[0]?.error?.message ||
  data.choices?.[0]?.message?.refusal ||
  `OpenRouter respondeu HTTP ${status}.`;

const isRetryable = (
  status: number,
  data: OpenRouterResponse
): boolean => {
  const code = Number(data.error?.code || status);

  return (
    status === 408 ||
    status === 409 ||
    status === 429 ||
    status >= 500 ||
    code === 429
  );
};

export const sendXpIAChat = async (
  input: XpIAChatInput
): Promise<XpIAChatResult> => {
  const apiKey =
    process.env.OPENROUTER_API_KEY?.trim();

  const models = getModels();

  if (!apiKey) {
    throw new Error(
      'OPENROUTER_API_KEY não configurada.'
    );
  }

  if (models.length === 0) {
    throw new Error(
      'Nenhum modelo OpenRouter foi configurado.'
    );
  }

  const timeoutMs = getNumberEnv(
    'OPENROUTER_TIMEOUT_MS',
    45000,
    5000,
    120000
  );

  const maxTokens = getNumberEnv(
    'OPENROUTER_MAX_TOKENS',
    1000,
    100,
    4000
  );

  const temperature = getNumberEnv(
    'OPENROUTER_TEMPERATURE',
    0.4,
    0,
    2
  );

  const requestMessages = [
    {
      role: 'system' as const,
      content: buildSystemPrompt(
        input.locale,
        input.context
      )
    },
    ...input.messages
  ];

  let lastError =
    'Nenhum provider OpenRouter respondeu.';

  for (const model of models) {
    const abortController = new AbortController();

    const timeout = setTimeout(() => {
      abortController.abort();
    }, timeoutMs);

    try {
      const requestBody: Record<string, unknown> = {
        model,
        messages: requestMessages,
        temperature,
        max_tokens: maxTokens,
        stream: false
      };

      if (input.userIdentifier) {
        requestBody.user = input.userIdentifier;
      }

      const response = await fetch(
        OPENROUTER_URL,
        {
          method: 'POST',

          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'HTTP-Referer':
              process.env.OPENROUTER_SITE_URL?.trim() ||
              'https://xpayments.digital',
            'X-OpenRouter-Title':
              process.env.OPENROUTER_APP_TITLE?.trim() ||
              'XPayments XpIA'
          },

          body: JSON.stringify(requestBody),

          signal: abortController.signal
        }
      );

      const rawText = await response.text();

      const data = parseResponse(
        rawText,
        response.status
      );

      if (!response.ok || data.error) {
        lastError = providerMessage(
          data,
          response.status
        );

        console.error(
          '[OPENROUTER_MODEL_ERROR]',
          {
            model,
            status: response.status,
            provider:
              data.error?.metadata?.provider_name ||
              data.provider ||
              null,
            message: lastError
          }
        );

        if (isRetryable(response.status, data)) {
          continue;
        }

        throw new Error(lastError);
      }

      const choice = data.choices?.[0];

      if (choice?.error) {
        lastError =
          choice.error.message ||
          'O provider recusou a geração.';

        console.error(
          '[OPENROUTER_CHOICE_ERROR]',
          {
            model,
            message: lastError
          }
        );

        continue;
      }

      const content =
        choice?.message?.content?.trim();

      if (!content) {
        lastError =
          choice?.message?.refusal ||
          'O provider não devolveu conteúdo.';

        console.error(
          '[OPENROUTER_EMPTY_CONTENT]',
          {
            model,
            requestId: data.id || null,
            finishReason:
              choice?.finish_reason || null,
            refusal:
              choice?.message?.refusal || null
          }
        );

        continue;
      }

      return {
        response: content,

        model:
          data.model ||
          model,

        requestId:
          data.id ||
          null,

        finishReason:
          choice?.finish_reason ||
          choice?.native_finish_reason ||
          null,

        usage: {
          promptTokens: Number(
            data.usage?.prompt_tokens ?? 0
          ),

          completionTokens: Number(
            data.usage?.completion_tokens ?? 0
          ),

          totalTokens: Number(
            data.usage?.total_tokens ?? 0
          ),

          cost:
            data.usage?.cost === undefined
              ? null
              : Number(data.usage.cost)
        }
      };
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === 'AbortError'
      ) {
        lastError =
          `Timeout ao utilizar o modelo ${model}.`;

        console.error(
          '[OPENROUTER_MODEL_TIMEOUT]',
          model
        );

        continue;
      }

      if (error instanceof Error) {
        lastError = error.message;
      } else {
        lastError =
          'Erro desconhecido ao comunicar com a OpenRouter.';
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(lastError);
};
