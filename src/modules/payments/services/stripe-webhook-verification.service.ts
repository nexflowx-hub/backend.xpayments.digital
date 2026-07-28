import { Request } from 'express';
import Stripe from 'stripe';

import prisma from '../../../core/prisma';

type Credentials = Record<string, unknown>;

type StripeVaultCandidate = {
  id: string;
  provider: string;
  credentials: unknown;
};

export type VerifiedStripeWebhook = {
  event: Stripe.Event;
  gatewayVaultId: string;
  provider: string;
};

export class StripeWebhookVerificationError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(
    statusCode: number,
    code: string,
    message: string
  ) {
    super(message);
    this.name = 'StripeWebhookVerificationError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

const parseCredentials = (
  value: unknown
): Credentials => {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    return value as Credentials;
  }

  if (typeof value !== 'string') {
    return {};
  }

  try {
    const parsed = JSON.parse(value);

    return parsed && typeof parsed === 'object'
      ? parsed as Credentials
      : {};
  } catch {
    return {};
  }
};

const getRawBody = (
  req: Request
): Buffer | null => {
  const candidate = (req as any).rawBody;

  if (Buffer.isBuffer(candidate)) {
    return candidate;
  }

  return null;
};

const getSignature = (
  req: Request
): string | null => {
  const signature = req.get('stripe-signature');

  return signature?.trim() || null;
};

const isFinancialEvent = (
  eventType: string
): boolean =>
  eventType === 'charge.updated' ||
  eventType.startsWith('payment_intent.');

const getEventTransactionIdentity = (
  event: Stripe.Event
): {
  transactionId: string | null;
  paymentIntentId: string | null;
} => {
  const object = event.data?.object as any;

  const metadataTransactionId =
    object?.metadata?.nexflowx_transaction_id;

  const transactionId =
    typeof metadataTransactionId === 'string' &&
    /^[0-9a-f-]{36}$/i.test(metadataTransactionId)
      ? metadataTransactionId
      : null;

  if (event.type.startsWith('payment_intent.')) {
    return {
      transactionId,
      paymentIntentId:
        typeof object?.id === 'string'
          ? object.id
          : null
    };
  }

  const paymentIntent = object?.payment_intent;

  return {
    transactionId,
    paymentIntentId:
      typeof paymentIntent === 'string'
        ? paymentIntent
        : typeof paymentIntent?.id === 'string'
          ? paymentIntent.id
          : null
  };
};

const assertTransactionVaultBinding = async (
  event: Stripe.Event,
  gatewayVaultId: string,
  provider: string
): Promise<void> => {
  if (!isFinancialEvent(event.type)) {
    return;
  }

  const identity =
    getEventTransactionIdentity(event);

  const transaction = identity.transactionId
    ? await prisma.transaction.findUnique({
        where: {
          id: identity.transactionId
        },
        select: {
          id: true,
          providerId: true,
          gatewayVaultId: true
        }
      })
    : identity.paymentIntentId
      ? await prisma.transaction.findFirst({
          where: {
            providerId: identity.paymentIntentId
          },
          select: {
            id: true,
            providerId: true,
            gatewayVaultId: true
          }
        })
      : null;

  /*
   * Um evento Stripe genuíno pode não pertencer a esta base.
   * O handler existente devolve 200/ignored nesses casos.
   */
  if (!transaction) {
    return;
  }

  if (!transaction.gatewayVaultId) {
    throw new StripeWebhookVerificationError(
      409,
      'STRIPE_TRANSACTION_VAULT_MISSING',
      'A transação não possui Gateway Vault associado.'
    );
  }

  if (transaction.gatewayVaultId !== gatewayVaultId) {
    console.error(
      '[STRIPE WEBHOOK VAULT MISMATCH]',
      {
        eventId: event.id,
        eventType: event.type,
        transactionId: transaction.id,
        transactionGatewayVaultId:
          transaction.gatewayVaultId,
        verifiedGatewayVaultId:
          gatewayVaultId,
        verifiedProvider: provider
      }
    );

    throw new StripeWebhookVerificationError(
      409,
      'STRIPE_WEBHOOK_VAULT_MISMATCH',
      'O evento não corresponde ao Gateway Vault da transação.'
    );
  }

  if (
    identity.paymentIntentId &&
    transaction.providerId &&
    transaction.providerId !== identity.paymentIntentId
  ) {
    throw new StripeWebhookVerificationError(
      409,
      'STRIPE_PAYMENT_INTENT_MISMATCH',
      'O PaymentIntent não corresponde à transação.'
    );
  }
};

const getVaultCandidates = async (): Promise<
  StripeVaultCandidate[]
> =>
  prisma.gatewayVault.findMany({
    where: {
      isActive: true,
      provider: {
        startsWith: 'stripe-'
      }
    },
    select: {
      id: true,
      provider: true,
      credentials: true
    },
    orderBy: {
      provider: 'asc'
    }
  });

export const verifyStripeWebhookRequest = async (
  req: Request
): Promise<VerifiedStripeWebhook> => {
  const rawBody = getRawBody(req);
  const signature = getSignature(req);

  if (!rawBody) {
    throw new StripeWebhookVerificationError(
      400,
      'STRIPE_RAW_BODY_MISSING',
      'Corpo bruto do webhook Stripe indisponível.'
    );
  }

  if (!signature) {
    throw new StripeWebhookVerificationError(
      400,
      'STRIPE_SIGNATURE_MISSING',
      'Cabeçalho Stripe-Signature ausente.'
    );
  }

  const vaults = await getVaultCandidates();

  if (vaults.length === 0) {
    throw new StripeWebhookVerificationError(
      503,
      'STRIPE_WEBHOOK_VAULTS_UNAVAILABLE',
      'Nenhum Gateway Vault Stripe ativo foi encontrado.'
    );
  }

  let configuredSecrets = 0;

  for (const vault of vaults) {
    const credentials = parseCredentials(
      vault.credentials
    );

    const webhookSecret = String(
      credentials.webhookSecret || ''
    ).trim();

    const secretKey = String(
      credentials.secretKey || ''
    ).trim();

    if (!webhookSecret || !secretKey) {
      continue;
    }

    configuredSecrets += 1;

    try {
      const stripe = new Stripe(
        secretKey,
        {
          apiVersion:
            '2026-06-24.dahlia' as any,
          maxNetworkRetries: 0,
          timeout: 10000
        }
      );

      const event =
        stripe.webhooks.constructEvent(
          rawBody,
          signature,
          webhookSecret
        );

      await assertTransactionVaultBinding(
        event,
        vault.id,
        vault.provider
      );

      return {
        event,
        gatewayVaultId: vault.id,
        provider: vault.provider
      };
    } catch (error) {
      if (
        error instanceof
          StripeWebhookVerificationError
      ) {
        throw error;
      }

      /*
       * A assinatura pode pertencer a outro Vault Stripe.
       * Continuamos até encontrar o signing secret correto.
       */
    }
  }

  if (configuredSecrets === 0) {
    throw new StripeWebhookVerificationError(
      503,
      'STRIPE_WEBHOOK_SECRETS_UNAVAILABLE',
      'Nenhum signing secret Stripe está configurado.'
    );
  }

  throw new StripeWebhookVerificationError(
    400,
    'STRIPE_SIGNATURE_INVALID',
    'Assinatura do webhook Stripe inválida.'
  );
};
