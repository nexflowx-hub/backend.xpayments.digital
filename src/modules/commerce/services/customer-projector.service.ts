import { Prisma } from '@prisma/client';

import prisma from '../../../core/prisma';

type JsonRecord = Record<string, unknown>;

interface CustomerAggregateRow {
  orders: bigint | number;
  ltv: Prisma.Decimal | number | string | null;
  first_seen: Date | string | null;
  last_seen: Date | string | null;
}

export interface CustomerProjectionResult {
  projected: boolean;
  customerId: string | null;
  merchantId: string | null;
  email: string | null;
  reason: string;
}

const asRecord = (value: unknown): JsonRecord =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};

const cleanString = (value: unknown): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized ? normalized : null;
};

const normalizeEmail = (value: unknown): string | null => {
  const email = cleanString(value)?.toLowerCase() ?? null;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return null;
  }

  return email;
};

const firstString = (...values: unknown[]): string | null => {
  for (const value of values) {
    const normalized = cleanString(value);
    if (normalized) {
      return normalized;
    }
  }

  return null;
};

const getIdentityFromTransaction = (transaction: {
  customer: string | null;
  customerEmail: string | null;
  rawRequest: unknown;
  metadata: unknown;
}) => {
  const raw = asRecord(transaction.rawRequest);
  const metadata = asRecord(transaction.metadata);
  const rawCustomer = asRecord(raw.customer);
  const rawAddress = asRecord(rawCustomer.address);
  const metadataCustomer = asRecord(metadata.customer);

  const email = normalizeEmail(
    firstString(
      transaction.customerEmail,
      rawCustomer.email,
      metadataCustomer.email,
      metadata.customer_email,
      raw.email
    )
  );

  const name = firstString(
    transaction.customer,
    rawCustomer.name,
    metadataCustomer.name,
    metadata.customer_name,
    raw.customer_name
  );

  const country = firstString(
    rawCustomer.country,
    rawAddress.country,
    metadataCustomer.country,
    metadata.customer_country,
    metadata.country
  )?.toUpperCase() ?? null;

  return {
    email,
    name,
    country
  };
};

const segmentFor = (orders: number, ltv: number): string => {
  if (orders >= 5 || ltv >= 1000) {
    return 'loyal';
  }

  if (orders >= 2) {
    return 'repeat';
  }

  return 'new';
};

/**
 * Projects payment/transaction data into the existing Customer read model.
 *
 * Safety properties:
 * - independent from payment authorization/capture;
 * - idempotent for the same transaction history;
 * - never modifies Transaction, Wallet, WalletMovement or provider state;
 * - only successful transactions contribute to orders/LTV;
 * - identity can be enriched by pending/failed attempts without creating
 *   financial side effects.
 */
export const projectCustomerFromTransaction = async (
  transactionId: string
): Promise<CustomerProjectionResult> => {
  const transaction = await prisma.transaction.findUnique({
    where: {
      id: transactionId
    },
    select: {
      id: true,
      merchantId: true,
      customer: true,
      customerEmail: true,
      rawRequest: true,
      metadata: true,
      createdAt: true
    }
  });

  if (!transaction) {
    return {
      projected: false,
      customerId: null,
      merchantId: null,
      email: null,
      reason: 'transaction_not_found'
    };
  }

  const identity = getIdentityFromTransaction(transaction);

  if (!identity.email) {
    return {
      projected: false,
      customerId: null,
      merchantId: transaction.merchantId,
      email: null,
      reason: 'customer_email_missing'
    };
  }

  const [aggregate] = await prisma.$queryRaw<CustomerAggregateRow[]>(Prisma.sql`
    SELECT
      COUNT(*) FILTER (WHERE lower(status) = 'succeeded') AS orders,
      COALESCE(
        SUM(amount) FILTER (WHERE lower(status) = 'succeeded'),
        0
      ) AS ltv,
      MIN(created_at) AS first_seen,
      MAX(created_at) AS last_seen
    FROM transactions
    WHERE merchant_id = ${transaction.merchantId}::uuid
      AND lower(
        COALESCE(
          NULLIF(btrim(customer_email), ''),
          NULLIF(btrim(raw_request #>> '{customer,email}'), ''),
          NULLIF(btrim(metadata #>> '{customer,email}'), ''),
          NULLIF(btrim(metadata ->> 'customer_email'), '')
        )
      ) = ${identity.email}
  `);

  const orders = Number(aggregate?.orders ?? 0);
  const ltv = Number(aggregate?.ltv ?? 0);
  const avgOrder = orders > 0 ? Number((ltv / orders).toFixed(2)) : 0;
  const firstSeen = aggregate?.first_seen
    ? new Date(aggregate.first_seen)
    : transaction.createdAt;
  const lastSeen = aggregate?.last_seen
    ? new Date(aggregate.last_seen)
    : transaction.createdAt;

  const existing = await prisma.customer.findFirst({
    where: {
      merchantId: transaction.merchantId,
      email: {
        equals: identity.email,
        mode: 'insensitive'
      }
    },
    orderBy: {
      lastSeen: 'desc'
    }
  });

  const data = {
    email: identity.email,
    name: identity.name ?? existing?.name ?? null,
    country: identity.country ?? existing?.country ?? null,
    orders,
    ltv,
    avgOrder,
    segment: segmentFor(orders, ltv),
    status: existing?.status ?? 'active',
    firstSeen,
    lastSeen
  };

  const customer = existing
    ? await prisma.customer.update({
        where: {
          id: existing.id
        },
        data
      })
    : await prisma.customer.create({
        data: {
          merchantId: transaction.merchantId,
          ...data
        }
      });

  return {
    projected: true,
    customerId: customer.id,
    merchantId: transaction.merchantId,
    email: identity.email,
    reason: existing ? 'updated' : 'created'
  };
};
