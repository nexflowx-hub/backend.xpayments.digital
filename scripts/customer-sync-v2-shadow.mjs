#!/usr/bin/env node

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  log: ['error']
});

const num = value => Number(value ?? 0);

const print = (label, value) => {
  console.log(`${label}=${typeof value === 'object' ? JSON.stringify(value) : value}`);
};

const main = async () => {
  console.log('======================================================');
  console.log(' XPAYMENTS CUSTOMER SYNC V2 — SHADOW READ-ONLY');
  console.log('======================================================');

  const result = await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');

    const [totals] = await tx.$queryRawUnsafe(`
      SELECT
        (SELECT COUNT(*)::bigint FROM public.transactions) AS transactions,
        (SELECT COUNT(*)::bigint FROM public.customers) AS customers,
        (SELECT COUNT(*)::bigint FROM public.customer_transaction_links) AS links,
        (SELECT COUNT(*)::bigint FROM public.customer_events) AS events,
        (SELECT COUNT(*)::bigint FROM public.customer_transaction_sync_state) AS sync_state
    `);

    const [newEligible] = await tx.$queryRawUnsafe(`
      WITH eligible AS (
        SELECT
          t.id,
          t.merchant_id,
          LOWER(BTRIM(COALESCE(
            NULLIF(t.customer_email, ''),
            NULLIF(t.raw_request #>> '{customer,email}', ''),
            NULLIF(t.raw_request #>> '{customer,billing_details,email}', ''),
            NULLIF(t.metadata #>> '{customer,email}', ''),
            NULLIF(t.metadata ->> 'customer_email', ''),
            NULLIF(t.raw_request ->> 'email', '')
          ))) AS normalized_email
        FROM public.transactions t
        LEFT JOIN public.customer_transaction_links l
          ON l.transaction_id = t.id
        WHERE l.transaction_id IS NULL
      )
      SELECT
        COUNT(*) FILTER (
          WHERE normalized_email IS NOT NULL
            AND normalized_email ~* '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$'
        )::bigint AS unlinked_eligible,
        COUNT(DISTINCT (merchant_id::text || ':' || normalized_email)) FILTER (
          WHERE normalized_email IS NOT NULL
            AND normalized_email ~* '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$'
        )::bigint AS affected_identities
      FROM eligible
    `);

    const [statusChanges] = await tx.$queryRawUnsafe(`
      SELECT
        COUNT(*)::bigint AS status_changes,
        COUNT(DISTINCT l.customer_id)::bigint AS affected_customers
      FROM public.customer_transaction_links l
      JOIN public.transactions t
        ON t.id = l.transaction_id
      LEFT JOIN public.customer_transaction_sync_state ss
        ON ss.transaction_id = l.transaction_id
      WHERE ss.transaction_id IS NULL
         OR LOWER(COALESCE(ss.last_status, '')) <> LOWER(COALESCE(t.status, ''))
    `);

    const [enrichment] = await tx.$queryRawUnsafe(`
      WITH candidate AS (
        SELECT DISTINCT ON (l.customer_id)
          l.customer_id,
          c.name AS current_name,
          c.phone AS current_phone,
          c.country AS current_country,
          COALESCE(
            NULLIF(BTRIM(t.customer), ''),
            NULLIF(BTRIM(t.raw_request #>> '{customer,name}'), ''),
            NULLIF(BTRIM(t.raw_request #>> '{customer,billing_details,name}'), ''),
            NULLIF(BTRIM(t.metadata #>> '{customer,name}'), ''),
            NULLIF(BTRIM(t.metadata ->> 'customer_name'), '')
          ) AS candidate_name,
          COALESCE(
            NULLIF(BTRIM(t.raw_request #>> '{customer,phone}'), ''),
            NULLIF(BTRIM(t.raw_request #>> '{customer,billing_details,phone}'), ''),
            NULLIF(BTRIM(t.metadata #>> '{customer,phone}'), ''),
            NULLIF(BTRIM(t.metadata ->> 'customer_phone'), ''),
            NULLIF(BTRIM(t.raw_request ->> 'phone'), '')
          ) AS candidate_phone,
          UPPER(COALESCE(
            NULLIF(BTRIM(t.country), ''),
            NULLIF(BTRIM(t.raw_request #>> '{customer,country}'), ''),
            NULLIF(BTRIM(t.raw_request #>> '{customer,address,country}'), ''),
            NULLIF(BTRIM(t.raw_request #>> '{customer,billing_details,address,country}'), ''),
            NULLIF(BTRIM(t.metadata #>> '{customer,country}'), ''),
            NULLIF(BTRIM(t.metadata ->> 'customer_country'), ''),
            NULLIF(BTRIM(t.metadata ->> 'country'), '')
          )) AS candidate_country,
          t.created_at
        FROM public.customer_transaction_links l
        JOIN public.customers c
          ON c.id = l.customer_id
        JOIN public.transactions t
          ON t.id = l.transaction_id
        ORDER BY l.customer_id, t.created_at DESC
      )
      SELECT
        COUNT(*) FILTER (
          WHERE (current_name IS NULL OR BTRIM(current_name) = '')
            AND candidate_name IS NOT NULL
        )::bigint AS name_candidates,
        COUNT(*) FILTER (
          WHERE (current_phone IS NULL OR BTRIM(current_phone) = '')
            AND candidate_phone IS NOT NULL
        )::bigint AS phone_candidates,
        COUNT(*) FILTER (
          WHERE (current_country IS NULL OR BTRIM(current_country) = '')
            AND candidate_country IS NOT NULL
        )::bigint AS country_candidates
      FROM candidate
    `);

    const [integrity] = await tx.$queryRawUnsafe(`
      SELECT
        (
          SELECT COUNT(*)::bigint
          FROM public.customer_transaction_links l
          JOIN public.customers c ON c.id = l.customer_id
          JOIN public.transactions t ON t.id = l.transaction_id
          WHERE l.merchant_id <> c.merchant_id
             OR l.merchant_id <> t.merchant_id
        ) AS merchant_mismatch,
        (
          SELECT COUNT(*)::bigint
          FROM public.customer_transaction_links l
          LEFT JOIN public.transactions t ON t.id = l.transaction_id
          WHERE t.id IS NULL
        ) AS orphan_links,
        (
          SELECT COUNT(*)::bigint
          FROM public.customer_transaction_sync_state ss
          LEFT JOIN public.customer_transaction_links l
            ON l.transaction_id = ss.transaction_id
          WHERE l.transaction_id IS NULL
        ) AS sync_without_link,
        (
          SELECT COUNT(*)::bigint
          FROM (
            SELECT merchant_id, normalized_email
            FROM public.customers
            WHERE normalized_email IS NOT NULL
            GROUP BY merchant_id, normalized_email
            HAVING COUNT(*) > 1
          ) d
        ) AS duplicate_customer_identities
    `);

    const oldCycleWrites = num(totals?.links) + num(totals?.customers);
    const v2Affected =
      num(newEligible?.unlinked_eligible) +
      num(statusChanges?.status_changes) +
      num(enrichment?.name_candidates) +
      num(enrichment?.phone_candidates) +
      num(enrichment?.country_candidates);

    return {
      totals: {
        transactions: num(totals?.transactions),
        customers: num(totals?.customers),
        links: num(totals?.links),
        events: num(totals?.events),
        syncState: num(totals?.sync_state)
      },
      incremental: {
        unlinkedEligible: num(newEligible?.unlinked_eligible),
        affectedNewIdentities: num(newEligible?.affected_identities),
        statusChanges: num(statusChanges?.status_changes),
        affectedExistingCustomers: num(statusChanges?.affected_customers),
        enrichmentNameCandidates: num(enrichment?.name_candidates),
        enrichmentPhoneCandidates: num(enrichment?.phone_candidates),
        enrichmentCountryCandidates: num(enrichment?.country_candidates)
      },
      integrity: {
        merchantMismatch: num(integrity?.merchant_mismatch),
        orphanLinks: num(integrity?.orphan_links),
        syncWithoutLink: num(integrity?.sync_without_link),
        duplicateCustomerIdentities: num(integrity?.duplicate_customer_identities)
      },
      comparison: {
        approximateV1WritesPerIdleCycle: oldCycleWrites,
        v2CandidateRowsThisCycle: v2Affected,
        avoidedRowsIfIdleEquivalent: Math.max(0, oldCycleWrites - v2Affected)
      }
    };
  }, {
    isolationLevel: 'RepeatableRead',
    timeout: 60000,
    maxWait: 10000
  });

  print('TOTALS', result.totals);
  print('V2_INCREMENTAL', result.incremental);
  print('INTEGRITY', result.integrity);
  print('V1_VS_V2', result.comparison);

  const integrityOk = Object.values(result.integrity).every(value => value === 0);

  print('SHADOW_INTEGRITY', integrityOk ? 'PASS' : 'FAIL');
  print('DB_MODE', 'READ_ONLY');
  print('CUSTOMER_SYNC_V2_SHADOW', integrityOk ? 'PASS' : 'FAIL');

  if (!integrityOk) {
    process.exitCode = 2;
  }
};

main()
  .catch(error => {
    console.error('CUSTOMER_SYNC_V2_SHADOW_ERROR');
    console.error(error?.message ?? error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
