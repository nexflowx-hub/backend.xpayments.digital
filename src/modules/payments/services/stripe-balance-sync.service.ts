import { Prisma } from '@prisma/client';
import Stripe from 'stripe';

import prisma from '../../../core/prisma';

type StripeEventLike = {
  id?: string;
  type?: string;
  data?: {
    object?: any;
  };
};

export type StripeBalanceSyncResult = {
  synced: boolean;
  reason?: string;
  transactionId?: string;
  paymentIntentId?: string | null;
  chargeId?: string | null;
  balanceTransactionId?: string | null;
  movementCount?: number;
  availableOn?: string | null;
  providerStatus?: string | null;
  gross?: number;
  providerFee?: number;
  providerNet?: number;
  platformFee?: number;
  merchantNet?: number;
};

const FINANCE_TIMEZONE = 'Europe/Lisbon';

const roundMoney = (value: unknown): number => {
  const parsed = Number(value ?? 0);

  return Number.isFinite(parsed)
    ? Math.round((parsed + Number.EPSILON) * 100) / 100
    : 0;
};

const fromMinorUnit = (value: unknown): number =>
  roundMoney(Number(value ?? 0) / 100);

const parseCredentials = (
  value: unknown
): Record<string, unknown> => {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    return value as Record<string, unknown>;
  }

  if (typeof value !== 'string') {
    return {};
  }

  try {
    const parsed = JSON.parse(value);

    return parsed && typeof parsed === 'object'
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
};

const civilDateFromUnix = (
  timestamp: number | null | undefined
): string | null => {
  if (!timestamp) {
    return null;
  }

  const parts = new Intl.DateTimeFormat(
    'en-CA',
    {
      timeZone: FINANCE_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }
  ).formatToParts(
    new Date(timestamp * 1000)
  );

  const values = Object.fromEntries(
    parts.map(part => [
      part.type,
      part.value
    ])
  );

  return `${values.year}-${values.month}-${values.day}`;
};

const getPaymentIntentId = (
  event: StripeEventLike
): string | null => {
  const object = event.data?.object;

  if (!object) {
    return null;
  }

  if (
    String(event.type || '').startsWith(
      'payment_intent.'
    )
  ) {
    return typeof object.id === 'string'
      ? object.id
      : null;
  }

  const paymentIntent = object.payment_intent;

  if (typeof paymentIntent === 'string') {
    return paymentIntent;
  }

  return typeof paymentIntent?.id === 'string'
    ? paymentIntent.id
    : null;
};

const getChargeId = (
  event: StripeEventLike
): string | null => {
  const object = event.data?.object;

  if (!object) {
    return null;
  }

  if (
    String(event.type || '').startsWith('charge.')
  ) {
    return typeof object.id === 'string'
      ? object.id
      : null;
  }

  const latestCharge = object.latest_charge;

  if (typeof latestCharge === 'string') {
    return latestCharge;
  }

  return typeof latestCharge?.id === 'string'
    ? latestCharge.id
    : null;
};

const resolveBalanceTransaction = async (
  stripe: Stripe,
  event: StripeEventLike,
  paymentIntentId: string | null
): Promise<{
  chargeId: string | null;
  balanceTransaction: Stripe.BalanceTransaction | null;
}> => {
  const eventObject = event.data?.object;
  let charge: any = null;

  if (
    String(event.type || '').startsWith('charge.')
  ) {
    charge = eventObject;
  }

  if (charge?.balance_transaction) {
    const balanceTransaction =
      typeof charge.balance_transaction === 'string'
        ? await stripe.balanceTransactions.retrieve(
            charge.balance_transaction
          )
        : charge.balance_transaction;

    return {
      chargeId:
        typeof charge.id === 'string'
          ? charge.id
          : null,
      balanceTransaction:
        balanceTransaction as Stripe.BalanceTransaction
    };
  }

  if (!paymentIntentId) {
    return {
      chargeId: getChargeId(event),
      balanceTransaction: null
    };
  }

  const paymentIntent =
    await stripe.paymentIntents.retrieve(
      paymentIntentId,
      {
        expand: [
          'latest_charge.balance_transaction'
        ]
      }
    );

  charge = paymentIntent.latest_charge;

  if (!charge) {
    return {
      chargeId: null,
      balanceTransaction: null
    };
  }

  if (typeof charge === 'string') {
    charge = await stripe.charges.retrieve(
      charge,
      {
        expand: [
          'balance_transaction'
        ]
      }
    );
  }

  let balanceTransaction =
    charge.balance_transaction || null;

  if (typeof balanceTransaction === 'string') {
    balanceTransaction =
      await stripe.balanceTransactions.retrieve(
        balanceTransaction
      );
  }

  return {
    chargeId:
      typeof charge.id === 'string'
        ? charge.id
        : null,
    balanceTransaction:
      balanceTransaction
        ? balanceTransaction as Stripe.BalanceTransaction
        : null
  };
};

export const syncStripeBalanceFromWebhookEvent =
  async (
    event: StripeEventLike
  ): Promise<StripeBalanceSyncResult> => {
    const eventObject = event.data?.object;

    const metadataTransactionId =
      eventObject
        ?.metadata
        ?.nexflowx_transaction_id;

    const paymentIntentId =
      getPaymentIntentId(event);

    const transaction =
      typeof metadataTransactionId === 'string' &&
      metadataTransactionId
        ? await prisma.transaction.findUnique({
            where: {
              id: metadataTransactionId
            },
            include: {
              gatewayVault: true
            }
          })
        : paymentIntentId
          ? await prisma.transaction.findFirst({
              where: {
                providerId: paymentIntentId
              },
              include: {
                gatewayVault: true
              }
            })
          : null;

    if (!transaction) {
      return {
        synced: false,
        reason: 'transaction_not_found',
        paymentIntentId,
        chargeId: getChargeId(event)
      };
    }

    const vault = transaction.gatewayVault;

    if (!vault) {
      return {
        synced: false,
        reason: 'gateway_vault_missing',
        transactionId: transaction.id,
        paymentIntentId,
        chargeId: getChargeId(event)
      };
    }

    const credentials = parseCredentials(
      vault.credentials
    );

    const secretKey = String(
      credentials.secretKey || ''
    ).trim();

    if (!secretKey) {
      return {
        synced: false,
        reason: 'stripe_secret_missing',
        transactionId: transaction.id,
        paymentIntentId,
        chargeId: getChargeId(event)
      };
    }

    const stripe = new Stripe(
      secretKey,
      {
        apiVersion:
          '2026-06-24.dahlia' as any,
        maxNetworkRetries: 2,
        timeout: 30000
      }
    );

    const resolved =
      await resolveBalanceTransaction(
        stripe,
        event,
        paymentIntentId || transaction.providerId
      );

    const balanceTransaction =
      resolved.balanceTransaction;

    if (!balanceTransaction) {
      return {
        synced: false,
        reason: 'balance_transaction_not_ready',
        transactionId: transaction.id,
        paymentIntentId:
          paymentIntentId || transaction.providerId,
        chargeId: resolved.chargeId
      };
    }

    const gross = roundMoney(
      transaction.amount
    );

    const providerFee = fromMinorUnit(
      balanceTransaction.fee
    );

    const providerNet = fromMinorUnit(
      balanceTransaction.net
    );

    /*
     * transaction.fee é o snapshot da taxa XPayments
     * já aplicado pelo motor atual. Esta sincronização
     * não altera a política comercial nem recalcula a taxa.
     */
    const platformFee = roundMoney(
      transaction.fee
    );

    const merchantNet = roundMoney(
      gross - providerFee - platformFee
    );

    const availableOn = civilDateFromUnix(
      balanceTransaction.available_on
    );

    const providerStatus = String(
      balanceTransaction.status || 'unknown'
    ).toLowerCase();

    const metadataPatch = JSON.stringify({
      stripeBalanceSync: {
        eventId: event.id || null,
        eventType: event.type || null,
        balanceTransactionId:
          balanceTransaction.id,
        chargeId: resolved.chargeId,
        paymentIntentId:
          paymentIntentId || transaction.providerId,
        providerStatus,
        availableOn,
        gross,
        providerFee,
        providerNet,
        platformFee,
        merchantNet,
        syncedAt:
          new Date().toISOString()
      }
    });

    const movementCount =
      await prisma.$executeRaw(
        Prisma.sql`
          UPDATE public.wallet_movements

          SET
            provider_balance_transaction_id =
              ${balanceTransaction.id},

            provider_balance_status =
              ${providerStatus},

            provider_gross =
              ${gross},

            provider_fee =
              ${providerFee},

            provider_net =
              ${providerNet},

            platform_fee =
              ${platformFee},

            merchant_net =
              ${merchantNet},

            provider_available_on =
              CASE
                WHEN ${availableOn}::text IS NULL
                  THEN provider_available_on
                ELSE ${availableOn}::date
              END,

            expected_release_at =
              CASE
                WHEN manual_estimated_release_on
                  IS NOT NULL
                  THEN expected_release_at

                WHEN ${availableOn}::text IS NULL
                  THEN expected_release_at

                ELSE (
                  ${availableOn}::date::timestamp
                  AT TIME ZONE 'Europe/Lisbon'
                )
              END,

            release_date_source =
              CASE
                WHEN manual_estimated_release_on
                  IS NOT NULL
                  THEN 'manual'

                WHEN ${availableOn}::text IS NOT NULL
                  THEN 'provider'

                ELSE release_date_source
              END,

            metadata =
              COALESCE(
                metadata,
                '{}'::jsonb
              ) || ${metadataPatch}::jsonb,

            provider_synced_at =
              now(),

            updated_at =
              now()

          WHERE merchant_id =
            ${transaction.merchantId}::uuid

            AND type = 'payment'
            AND direction = 'in'

            AND (
              transaction_id =
                ${transaction.id}::uuid

              OR reference =
                ${transaction.id}
            )
        `
      );

    if (movementCount === 0) {
      return {
        synced: false,
        reason: 'wallet_movement_not_found',
        transactionId: transaction.id,
        paymentIntentId:
          paymentIntentId || transaction.providerId,
        chargeId: resolved.chargeId,
        balanceTransactionId:
          balanceTransaction.id,
        availableOn,
        providerStatus,
        gross,
        providerFee,
        providerNet,
        platformFee,
        merchantNet
      };
    }

    return {
      synced: true,
      transactionId: transaction.id,
      paymentIntentId:
        paymentIntentId || transaction.providerId,
      chargeId: resolved.chargeId,
      balanceTransactionId:
        balanceTransaction.id,
      movementCount,
      availableOn,
      providerStatus,
      gross,
      providerFee,
      providerNet,
      platformFee,
      merchantNet
    };
  };
