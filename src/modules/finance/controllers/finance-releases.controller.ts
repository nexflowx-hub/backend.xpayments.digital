import {
  Prisma
} from '@prisma/client';

import {
  Response
} from 'express';

import prisma from '../../../core/prisma';

import {
  AuthRequest
} from '../../../middleware/auth.middleware';

type DatabaseRow =
  Record<string, any>;

const FINANCE_TIMEZONE =
  'Europe/Lisbon';

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
    ? Math.trunc(parsed)
    : 0;
};

const toDate = (
  value: unknown
): string | null => {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value
      .toISOString()
      .slice(0, 10);
  }

  return String(value)
    .slice(0, 10);
};

const getMerchantId = (
  req: AuthRequest
): string | null =>
  req.merchantId ||
  req.user?.id ||
  null;

const getCurrency = (
  req: AuthRequest
): string => {
  const candidate =
    typeof req.query.currency ===
      'string'
      ? req.query.currency
          .trim()
          .toUpperCase()
      : 'EUR';

  return /^[A-Z]{3,5}$/.test(
    candidate
  )
    ? candidate
    : 'EUR';
};

const civilToday = (): string =>
  new Intl.DateTimeFormat(
    'en-CA',
    {
      timeZone:
        FINANCE_TIMEZONE,

      year:
        'numeric',

      month:
        '2-digit',

      day:
        '2-digit'
    }
  ).format(
    new Date()
  );

export const getProviderFinanceReleases =
  async (
    req: AuthRequest,
    res: Response
  ) => {
    const merchantId =
      getMerchantId(req);

    if (!merchantId) {
      return res.status(401).json({
        success:
          false,

        error: {
          code:
            'UNAUTHENTICATED',

          message:
            'Merchant não autenticado.'
        }
      });
    }

    const currency =
      getCurrency(req);

    try {
      const rows =
        await prisma.$queryRaw<
          DatabaseRow[]
        >(
          Prisma.sql`
            WITH funding AS (
              SELECT
                wallet_movement_id,

                COALESCE(
                  SUM(
                    allocated_amount
                  ),
                  0
                ) AS allocated_amount

              FROM
                public.payout_funding_allocations

              WHERE
                source_type =
                  'wallet_movement'

                AND wallet_movement_id
                  IS NOT NULL

              GROUP BY
                wallet_movement_id
            ),

            open_movements AS (
              SELECT
                movement.id,

                COALESCE(
                  movement.manual_estimated_release_on,
                  movement.provider_available_on,
                  movement.system_estimated_release_on,
                  (
                    movement.expected_release_at
                    AT TIME ZONE
                      'Europe/Lisbon'
                  )::date
                ) AS release_date,

                store.id AS store_id,
                store.store_code,
                store.name AS store_name,

                COALESCE(
                  transaction_record.gateway,
                  gateway_vault.provider,
                  'unknown'
                ) AS gateway,

                COALESCE(
                  movement.provider_gross,
                  transaction_record.amount,
                  movement.amount
                ) AS gross,

                COALESCE(
                  movement.provider_fee,
                  0
                ) AS provider_fee,

                COALESCE(
                  movement.platform_fee,
                  transaction_record.fee,
                  0
                ) AS platform_fee,

                GREATEST(
                  COALESCE(
                    movement.merchant_net,
                    movement.amount -
                      COALESCE(
                        movement.provider_fee,
                        0
                      )
                  ),
                  0
                ) AS original_net,

                LEAST(
                  COALESCE(
                    funding.allocated_amount,
                    0
                  ),

                  GREATEST(
                    COALESCE(
                      movement.merchant_net,
                      movement.amount -
                        COALESCE(
                          movement.provider_fee,
                          0
                        )
                    ),
                    0
                  )
                ) AS allocated_amount,

                GREATEST(
                  GREATEST(
                    COALESCE(
                      movement.merchant_net,
                      movement.amount -
                        COALESCE(
                          movement.provider_fee,
                          0
                        )
                    ),
                    0
                  ) -
                  COALESCE(
                    funding.allocated_amount,
                    0
                  ),
                  0
                ) AS remaining_net,

                movement.provider_balance_status,
                movement.provider_synced_at

              FROM public.wallet_movements
                AS movement

              LEFT JOIN public.transactions
                AS transaction_record

                ON (
                  transaction_record.id =
                    movement.transaction_id

                  OR transaction_record.id::text =
                    movement.reference
                )

              LEFT JOIN public.stores
                AS store

                ON store.id =
                  movement.store_id

              LEFT JOIN
                public.gateway_vaults
                  AS gateway_vault

                ON gateway_vault.id =
                  transaction_record
                    .gateway_vault_id

              LEFT JOIN funding

                ON funding.wallet_movement_id =
                  movement.id

              WHERE movement.merchant_id =
                ${merchantId}::uuid

                AND upper(
                  movement.currency
                ) = ${currency}

                AND movement.direction =
                  'in'

                AND movement.type =
                  'payment'

                AND movement.status IN (
                  'pendente',
                  'disponivel'
                )

                AND COALESCE(
                  movement.manual_estimated_release_on,
                  movement.provider_available_on,
                  movement.system_estimated_release_on,
                  (
                    movement.expected_release_at
                    AT TIME ZONE
                      'Europe/Lisbon'
                  )::date
                ) IS NOT NULL
            )

            SELECT
              release_date,

              store_id,
              store_code,
              store_name,
              gateway,

              COUNT(*) AS movement_count,

              COALESCE(
                SUM(gross),
                0
              ) AS gross,

              COALESCE(
                SUM(provider_fee),
                0
              ) AS provider_fees,

              COALESCE(
                SUM(platform_fee),
                0
              ) AS platform_fees,

              COALESCE(
                SUM(original_net),
                0
              ) AS original_net,

              COALESCE(
                SUM(allocated_amount),
                0
              ) AS allocated_amount,

              COALESCE(
                SUM(remaining_net),
                0
              ) AS net,

              COUNT(*) FILTER (
                WHERE lower(
                  COALESCE(
                    provider_balance_status,
                    ''
                  )
                ) = 'available'
              ) AS provider_available_count,

              COUNT(*) FILTER (
                WHERE lower(
                  COALESCE(
                    provider_balance_status,
                    ''
                  )
                ) = 'pending'
              ) AS provider_pending_count,

              COUNT(*) FILTER (
                WHERE
                  provider_balance_status
                    IS NULL

                  OR lower(
                    provider_balance_status
                  ) NOT IN (
                    'available',
                    'pending'
                  )
              ) AS provider_unknown_count,

              MAX(
                provider_synced_at
              ) AS provider_synced_at

            FROM open_movements

            WHERE remaining_net > 0

            GROUP BY
              release_date,
              store_id,
              store_code,
              store_name,
              gateway

            ORDER BY
              release_date,
              store_code,
              gateway
          `
        );

      const today =
        civilToday();

      const items =
        rows.map(row => {
          const date =
            toDate(
              row.release_date
            );

          const movementCount =
            toCount(
              row.movement_count
            );

          const availableCount =
            toCount(
              row.provider_available_count
            );

          const pendingCount =
            toCount(
              row.provider_pending_count
            );

          const unknownCount =
            toCount(
              row.provider_unknown_count
            );

          const providerStatus =
            movementCount > 0 &&
            availableCount ===
              movementCount
              ? 'available'
              : pendingCount > 0
                ? 'pending'
                : unknownCount > 0
                  ? 'unknown'
                  : 'unknown';

          const status =
            date &&
            date < today
              ? 'overdue'
              : 'expected';

          const operationalStatus =
            date &&
            date <= today
              ? 'awaiting_admin'
              : 'expected';

          const net =
            toNumber(
              row.net
            );

          return {
            date,

            storeId:
              row.store_id ||
              null,

            storeCode:
              row.store_code ||
              null,

            storeName:
              row.store_name ||
              null,

            gateway:
              row.gateway ||
              null,

            gross:
              toNumber(
                row.gross
              ),

            providerFees:
              toNumber(
                row.provider_fees
              ),

            platformFees:
              toNumber(
                row.platform_fees
              ),

            originalNet:
              toNumber(
                row.original_net
              ),

            allocatedAmount:
              toNumber(
                row.allocated_amount
              ),

            remainingAmount:
              net,

            net,
            amount:
              net,

            movementCount,

            providerStatus,

            providerAvailableCount:
              availableCount,

            providerPendingCount:
              pendingCount,

            providerUnknownCount:
              unknownCount,

            providerSyncedAt:
              row.provider_synced_at ||
              null,

            status,
            operationalStatus
          };
        });

      const awaitingAdminItems =
        items.filter(
          item =>
            item.operationalStatus ===
              'awaiting_admin'
        );

      return res.json({
        success:
          true,

        data: {
          currency,
          timezone:
            FINANCE_TIMEZONE,

          items,

          summary: {
            totalNet:
              toNumber(
                items.reduce(
                  (
                    total,
                    item
                  ) =>
                    total +
                    item.net,
                  0
                )
              ),

            movementCount:
              items.reduce(
                (
                  total,
                  item
                ) =>
                  total +
                  item.movementCount,
                0
              ),

            overdueNet:
              toNumber(
                awaitingAdminItems.reduce(
                  (
                    total,
                    item
                  ) =>
                    total +
                    item.net,
                  0
                )
              ),

            awaitingAdminNet:
              toNumber(
                awaitingAdminItems.reduce(
                  (
                    total,
                    item
                  ) =>
                    total +
                    item.net,
                  0
                )
              )
          },

          generatedAt:
            new Date()
              .toISOString()
        }
      });
    } catch (error) {
      console.error(
        '[FINANCE RELEASES] Falha ao carregar previsões.',
        error
      );

      return res
        .status(500)
        .json({
          success:
            false,

          error: {
            code:
              'FINANCE_RELEASES_QUERY_FAILED',

            message:
              'Erro ao carregar previsões de liberação.'
          }
        });
    }
  };
