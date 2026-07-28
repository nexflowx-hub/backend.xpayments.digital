import { Response } from 'express';
import { Prisma } from '@prisma/client';

import prisma from '../../../core/prisma';
import { AuthRequest } from '../../../middleware/auth.middleware';

type DatabaseRow = Record<string, any>;

const toNumber = (
  value: unknown
): number => {
  const parsed =
    Number(value ?? 0);

  return Number.isFinite(parsed)
    ? Math.round(
        (
          parsed +
          Number.EPSILON
        ) * 100
      ) / 100
    : 0;
};

const toCount = (
  value: unknown
): number => {
  const parsed =
    Number(value ?? 0);

  return Number.isFinite(parsed)
    ? parsed
    : 0;
};

const getMerchantId = (
  req: AuthRequest
): string | null => {
  return (
    req.merchantId ||
    req.user?.id ||
    null
  );
};

export const listPayoutStatements = async (
  req: AuthRequest,
  res: Response
) => {
  const merchantId =
    getMerchantId(req);

  if (!merchantId) {
    return res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHENTICATED',
        message: 'Merchant não autenticado.'
      }
    });
  }

  const status =
    typeof req.query.status === 'string'
      ? req.query.status
          .trim()
          .toLowerCase()
      : null;

  const currencyCandidate =
    typeof req.query.currency === 'string'
      ? req.query.currency
          .trim()
          .toUpperCase()
      : 'EUR';

  const currency =
    /^[A-Z]{3,5}$/.test(
      currencyCandidate
    )
      ? currencyCandidate
      : 'EUR';

  const limitCandidate =
    Number(req.query.limit || 100);

  const limit =
    Number.isFinite(limitCandidate)
      ? Math.min(
          Math.max(
            Math.trunc(
              limitCandidate
            ),
            1
          ),
          250
        )
      : 100;

  try {
    const rows =
      await prisma.$queryRaw<DatabaseRow[]>(
        Prisma.sql`
          SELECT
            payout.id,
            payout.statement_code,
            payout.currency,
            payout.amount,
            payout.status,
            payout.scheduled_for,
            payout.paid_on,
            payout.paid_at,
            payout.external_reference,
            payout.description,
            payout.historical_date_only,
            payout.metadata,
            payout.created_at,
            payout.updated_at,

            COALESCE(
              jsonb_agg(
                jsonb_build_object(
                  'storeId',
                  store.id,

                  'storeCode',
                  store.store_code,

                  'storeName',
                  store.name,

                  'amount',
                  allocation.amount
                )

                ORDER BY
                  store.store_code
              ) FILTER (
                WHERE allocation.id
                  IS NOT NULL
              ),

              '[]'::jsonb
            ) AS allocations

          FROM public.payout_statements
            AS payout

          LEFT JOIN
            public.payout_statement_allocations
              AS allocation

            ON allocation.payout_statement_id =
              payout.id

          LEFT JOIN public.stores
            AS store

            ON store.id =
              allocation.store_id

          WHERE payout.merchant_id =
            ${merchantId}::uuid

            AND upper(payout.currency) =
              ${currency}

            AND (
              ${status}::text IS NULL
              OR lower(payout.status) =
                ${status}::text
            )

          GROUP BY payout.id

          ORDER BY
            COALESCE(
              payout.paid_on,
              payout.scheduled_for,
              payout.created_at::date
            ) DESC,

            payout.created_at DESC

          LIMIT ${limit}
        `
      );

    const summaryRows =
      await prisma.$queryRaw<DatabaseRow[]>(
        Prisma.sql`
          SELECT
            COUNT(*) AS total_count,

            COUNT(*) FILTER (
              WHERE status = 'paid'
            ) AS paid_count,

            COUNT(*) FILTER (
              WHERE status IN (
                'scheduled',
                'processing'
              )
            ) AS scheduled_count,

            COUNT(*) FILTER (
              WHERE status = 'draft'
            ) AS draft_count,

            COALESCE(
              SUM(amount) FILTER (
                WHERE status = 'paid'
              ),
              0
            ) AS paid_amount,

            COALESCE(
              SUM(amount) FILTER (
                WHERE status IN (
                  'scheduled',
                  'processing'
                )
              ),
              0
            ) AS scheduled_amount

          FROM public.payout_statements

          WHERE merchant_id =
            ${merchantId}::uuid

            AND upper(currency) =
              ${currency}
        `
      );

    const summary =
      summaryRows[0] || {};

    return res.json({
      success: true,
      data: {
        currency,

        items:
          rows.map(row => ({
            id:
              row.id,

            statementCode:
              row.statement_code,

            currency:
              row.currency,

            amount:
              toNumber(row.amount),

            status:
              row.status,

            scheduledFor:
              row.scheduled_for,

            paidOn:
              row.paid_on,

            paidAt:
              row.paid_at,

            externalReference:
              row.external_reference,

            description:
              row.description,

            historicalDateOnly:
              Boolean(
                row.historical_date_only
              ),

            allocations:
              Array.isArray(
                row.allocations
              )
                ? row.allocations.map(
                    (
                      allocation: any
                    ) => ({
                      ...allocation,

                      amount:
                        toNumber(
                          allocation.amount
                        )
                    })
                  )
                : [],

            metadata:
              row.metadata || {},

            createdAt:
              row.created_at,

            updatedAt:
              row.updated_at
          })),

        summary: {
          totalCount:
            toCount(
              summary.total_count
            ),

          paidCount:
            toCount(
              summary.paid_count
            ),

          scheduledCount:
            toCount(
              summary.scheduled_count
            ),

          draftCount:
            toCount(
              summary.draft_count
            ),

          paidAmount:
            toNumber(
              summary.paid_amount
            ),

          scheduledAmount:
            toNumber(
              summary.scheduled_amount
            )
        },

        generatedAt:
          new Date().toISOString()
      }
    });
  } catch (error) {
    console.error(
      '[PAYOUT-STATEMENTS] Falha ao listar payouts.',
      error
    );

    return res.status(500).json({
      success: false,
      error: {
        code:
          'PAYOUT_STATEMENTS_QUERY_FAILED',

        message:
          'Erro ao carregar saídas e payouts.'
      }
    });
  }
};
