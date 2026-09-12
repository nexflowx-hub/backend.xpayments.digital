import { Prisma } from '@prisma/client';

import prisma from '../../../core/prisma';

type JsonRecord = Record<string, unknown>;

interface AggregateRow {
  orders: bigint | number;
  total_succeeded: bigint | number;
  total_failed: bigint | number;
  total_refunded: bigint | number;
  currency_count: bigint | number;
  ltv: string | number | null;
  avg_order: string | number | null;
  first_seen: Date | string | null;
  last_seen: Date | string | null;
  last_payment_at: Date | string | null;
}

interface CustomerIdRow {
  id: string;
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
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
};

const firstString = (...values: unknown[]): string | null => {
  for (const value of values) {
    const normalized = cleanString(value);
    if (normalized) return normalized;
  }
  return null;
};

const normalizeEmail = (value: unknown): string | null => {
  const email = cleanString(value)?.toLowerCase() ?? null;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
};

const normalizePhone = (value: unknown): string | null => {
  const raw = cleanString(value);
  if (!raw) return null;

  let phone = raw.replace(/\s+/g, '').replace(/[().-]/g, '');
  if (phone.startsWith('00')) phone = `+${phone.slice(2)}`;
  if (!phone.startsWith('+')) phone = `+${phone}`;

  return /^\+\d{8,15}$/.test(phone) ? phone : null;
};

const eventTypeForStatus = (status: string): string => {
  switch (status.toLowerCase()) {
    case 'succeeded': return 'payment.succeeded';
    case 'failed': return 'payment.failed';
    case 'canceled': return 'payment.canceled';
    case 'processing': return 'payment.processing';
    case 'refunded': return 'payment.refunded';
    default: return 'payment.pending';
  }
};

const segmentFor = (
  orders: number,
  lastPaymentAt: Date | string | null
): 'vip' | 'regular' | 'new' | 'at_risk' => {
  if (orders > 0 && lastPaymentAt) {
    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    if (new Date(lastPaymentAt).getTime() < cutoff) return 'at_risk';
  }
  if (orders >= 5) return 'vip';
  if (orders >= 2) return 'regular';
  return 'new';
};

const getIdentity = (transaction: {
  customer: string | null;
  customerEmail: string | null;
  rawRequest: unknown;
  metadata: unknown;
}) => {
  const raw = asRecord(transaction.rawRequest);
  const metadata = asRecord(transaction.metadata);
  const rawCustomer = asRecord(raw.customer);
  const rawAddress = asRecord(rawCustomer.address);
  const billing = asRecord(rawCustomer.billing_details);
  const billingAddress = asRecord(billing.address);
  const metadataCustomer = asRecord(metadata.customer);

  const email = normalizeEmail(firstString(
    transaction.customerEmail,
    rawCustomer.email,
    billing.email,
    metadataCustomer.email,
    metadata.customer_email,
    raw.email
  ));

  const name = firstString(
    transaction.customer,
    rawCustomer.name,
    billing.name,
    metadataCustomer.name,
    metadata.customer_name,
    raw.customer_name
  );

  const phone = firstString(
    rawCustomer.phone,
    billing.phone,
    metadataCustomer.phone,
    metadata.customer_phone,
    raw.phone
  );

  const country = firstString(
    rawCustomer.country,
    rawAddress.country,
    billingAddress.country,
    metadataCustomer.country,
    metadata.customer_country,
    metadata.country
  )?.toUpperCase() ?? null;

  return {
    email,
    name,
    phone,
    normalizedPhone: normalizePhone(phone),
    country
  };
};

/**
 * Idempotent projection from Transaction into the CRM read model already
 * present in production. It is deliberately independent from payment
 * authorization/capture and never mutates Transaction, Wallet, movement or
 * provider state.
 *
 * Legacy customers.ltv / avg_order are updated only when that customer has a
 * single transaction currency. Currency-aware reporting belongs to the CRM
 * read model (`metricsByCurrency`) so BRL/EUR/PLN are never added together.
 */
export const projectCustomerFromTransaction = async (
  transactionId: string,
  source = 'continuous_sync_v2'
): Promise<CustomerProjectionResult> => {
  const transaction = await prisma.transaction.findUnique({
    where: { id: transactionId },
    select: {
      id: true,
      merchantId: true,
      storeId: true,
      customer: true,
      customerEmail: true,
      amount: true,
      currency: true,
      method: true,
      status: true,
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

  const identity = getIdentity(transaction);

  if (!identity.email) {
    return {
      projected: false,
      customerId: null,
      merchantId: transaction.merchantId,
      email: null,
      reason: 'customer_email_missing'
    };
  }

  const customerId = await prisma.$transaction(async tx => {
    const [customer] = await tx.$queryRaw<CustomerIdRow[]>(Prisma.sql`
      INSERT INTO customers (
        merchant_id, name, email, phone, normalized_email, normalized_phone,
        country, first_seen, last_seen, updated_at
      )
      VALUES (
        ${transaction.merchantId}::uuid,
        ${identity.name}, ${identity.email}, ${identity.phone},
        ${identity.email}, ${identity.normalizedPhone}, ${identity.country},
        ${transaction.createdAt}, ${transaction.createdAt}, now()
      )
      ON CONFLICT (merchant_id, normalized_email)
        WHERE normalized_email IS NOT NULL
      DO UPDATE SET
        name = COALESCE(NULLIF(EXCLUDED.name, ''), customers.name),
        email = COALESCE(NULLIF(EXCLUDED.email, ''), customers.email),
        phone = COALESCE(NULLIF(EXCLUDED.phone, ''), customers.phone),
        normalized_phone = COALESCE(
          NULLIF(EXCLUDED.normalized_phone, ''), customers.normalized_phone
        ),
        country = COALESCE(NULLIF(EXCLUDED.country, ''), customers.country),
        first_seen = LEAST(customers.first_seen, EXCLUDED.first_seen),
        last_seen = GREATEST(customers.last_seen, EXCLUDED.last_seen),
        updated_at = now()
      RETURNING id::text
    `);

    if (!customer?.id) throw new Error('CUSTOMER_UPSERT_FAILED');

    await tx.$executeRaw(Prisma.sql`
      INSERT INTO customer_transaction_links (
        merchant_id, customer_id, transaction_id, source, linked_at
      ) VALUES (
        ${transaction.merchantId}::uuid,
        ${customer.id}::uuid,
        ${transaction.id}::uuid,
        ${source}, now()
      )
      ON CONFLICT (transaction_id)
      DO UPDATE SET
        merchant_id = EXCLUDED.merchant_id,
        customer_id = EXCLUDED.customer_id,
        source = EXCLUDED.source,
        linked_at = now()
    `);

    await tx.$executeRaw(Prisma.sql`
      INSERT INTO customer_transaction_sync_state (
        transaction_id, merchant_id, customer_id, last_status,
        first_synced_at, last_synced_at
      ) VALUES (
        ${transaction.id}::uuid,
        ${transaction.merchantId}::uuid,
        ${customer.id}::uuid,
        ${transaction.status}, now(), now()
      )
      ON CONFLICT (transaction_id)
      DO UPDATE SET
        merchant_id = EXCLUDED.merchant_id,
        customer_id = EXCLUDED.customer_id,
        last_status = EXCLUDED.last_status,
        last_synced_at = now()
    `);

    await tx.$executeRaw(Prisma.sql`
      INSERT INTO customer_events (
        merchant_id, customer_id, transaction_id, event_type,
        source, data, occurred_at
      ) VALUES (
        ${transaction.merchantId}::uuid,
        ${customer.id}::uuid,
        ${transaction.id}::uuid,
        ${eventTypeForStatus(transaction.status)},
        ${source},
        ${JSON.stringify({
          amount: Number(transaction.amount),
          currency: transaction.currency,
          method: transaction.method,
          status: transaction.status,
          storeId: transaction.storeId
        })}::jsonb,
        ${transaction.createdAt}
      )
      ON CONFLICT DO NOTHING
    `);

    return customer.id;
  });

  const [aggregate] = await prisma.$queryRaw<AggregateRow[]>(Prisma.sql`
    SELECT
      COUNT(*) FILTER (WHERE lower(status) = 'succeeded') AS orders,
      COUNT(*) FILTER (WHERE lower(status) = 'succeeded') AS total_succeeded,
      COUNT(*) FILTER (WHERE lower(status) = 'failed') AS total_failed,
      COUNT(*) FILTER (WHERE lower(status) = 'refunded') AS total_refunded,
      COUNT(DISTINCT upper(currency)) FILTER (
        WHERE lower(status) = 'succeeded'
      ) AS currency_count,
      COALESCE(SUM(amount) FILTER (
        WHERE lower(status) = 'succeeded'
      ), 0) AS ltv,
      COALESCE(AVG(amount) FILTER (
        WHERE lower(status) = 'succeeded'
      ), 0) AS avg_order,
      MIN(created_at) AS first_seen,
      MAX(created_at) AS last_seen,
      MAX(created_at) FILTER (
        WHERE lower(status) = 'succeeded'
      ) AS last_payment_at
    FROM transactions
    WHERE merchant_id = ${transaction.merchantId}::uuid
      AND lower(COALESCE(
        NULLIF(btrim(customer_email), ''),
        NULLIF(btrim(raw_request #>> '{customer,email}'), ''),
        NULLIF(btrim(metadata #>> '{customer,email}'), ''),
        NULLIF(btrim(metadata ->> 'customer_email'), '')
      )) = ${identity.email}
  `);

  const orders = Number(aggregate?.orders ?? 0);
  const totalSucceeded = Number(aggregate?.total_succeeded ?? 0);
  const totalFailed = Number(aggregate?.total_failed ?? 0);
  const totalRefunded = Number(aggregate?.total_refunded ?? 0);
  const currencyCount = Number(aggregate?.currency_count ?? 0);
  const ltv = Number(aggregate?.ltv ?? 0);
  const avgOrder = Number(aggregate?.avg_order ?? 0);
  const segment = segmentFor(orders, aggregate?.last_payment_at ?? null);

  await prisma.$executeRaw(Prisma.sql`
    UPDATE customers
    SET
      orders = ${orders},
      ltv = CASE WHEN ${currencyCount} <= 1 THEN ${ltv} ELSE ltv END,
      avg_order = CASE
        WHEN ${currencyCount} <= 1 THEN ${Number(avgOrder.toFixed(2))}
        ELSE avg_order
      END,
      total_succeeded = ${totalSucceeded},
      total_failed = ${totalFailed},
      total_refunded = ${totalRefunded},
      segment = ${segment},
      first_seen = COALESCE(${aggregate?.first_seen ?? null}, first_seen),
      last_seen = COALESCE(${aggregate?.last_seen ?? null}, last_seen),
      last_payment_at = ${aggregate?.last_payment_at ?? null},
      updated_at = now()
    WHERE id = ${customerId}::uuid
  `);

  return {
    projected: true,
    customerId,
    merchantId: transaction.merchantId,
    email: identity.email,
    reason: 'projected'
  };
};
