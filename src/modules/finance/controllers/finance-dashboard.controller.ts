import {
  Prisma
} from '@prisma/client';

import {
  Response
} from 'express';

import prisma from
  '../../../core/prisma';

import {
  AuthRequest
} from
  '../../../middleware/auth.middleware';

type DatabaseRow =
  Record<string, any>;

const FINANCE_TIMEZONE =
  'Europe/Lisbon';

const currencyPattern =
  /^[A-Z]{3,5}$/;

const money = (
  value: unknown
): number => {
  const parsed =
    Number(value ?? 0);

  if (
    !Number.isFinite(parsed)
  ) {
    return 0;
  }

  return Math.round(
    (
      parsed +
      Number.EPSILON
    ) * 100
  ) / 100;
};

const integer = (
  value: unknown
): number => {
  const parsed =
    Number(value ?? 0);

  return Number.isFinite(parsed)
    ? Math.trunc(parsed)
    : 0;
};

const subtract = (
  left: number,
  right: number
): number =>
  money(left - right);

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

  return currencyPattern.test(
    candidate
  )
    ? candidate
    : 'EUR';
};

const internalError = (
  res: Response,
  error: unknown
) => {
  console.error(
    '[FINANCE-DASHBOARD-V2]',
    error
  );

  return res.status(500).json({
    success: false,

    error: {
      code:
        'FINANCE_DASHBOARD_QUERY_FAILED',

      message:
        'Erro ao carregar o painel financeiro.'
    }
  });
};

export const getFinanceDashboardV2 =
  async (
    req: AuthRequest,
    res: Response
  ) => {
    const merchantId =
      getMerchantId(req);

    if (!merchantId) {
      return res.status(401).json({
        success: false,

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
      const [
        merchantSalesRows,
        walletRows,
        merchantPayoutRows,
        merchantAdjustmentRows,
        storeRows
      ] = await Promise.all([
        prisma.$queryRaw<
          DatabaseRow[]
        >(
          Prisma.sql`
            WITH ranked_movements AS (
              SELECT
                movement.*,

                ROW_NUMBER() OVER (
                  PARTITION BY
                    movement.transaction_id

                  ORDER BY
                    movement.updated_at DESC,
                    movement.created_at DESC,
                    movement.id DESC
                ) AS row_position

              FROM public.wallet_movements
                AS movement

              WHERE movement.merchant_id =
                  ${merchantId}::uuid

                AND movement.type =
                  'payment'

                AND movement.direction =
                  'in'

                AND movement.transaction_id
                  IS NOT NULL
            ),

            canonical_transactions AS (
              SELECT
                transaction_record.id,
                transaction_record.store_id,
                transaction_record.created_at,
                transaction_record.amount,

                COALESCE(
                  movement.merchant_net,

                  CASE
                    WHEN movement.provider_net
                      IS NOT NULL

                    THEN
                      movement.provider_net -
                      COALESCE(
                        movement.platform_fee,
                        0
                      )
                  END,

                  CASE
                    WHEN movement.amount
                      IS NOT NULL

                    THEN
                      movement.amount -
                      COALESCE(
                        movement.provider_fee,
                        0
                      )
                  END,

                  transaction_record.amount -
                  COALESCE(
                    transaction_record.fee,
                    0
                  )
                ) AS canonical_net,

                CASE
                  WHEN movement.transaction_id
                    IS NULL

                  THEN 1

                  ELSE 0
                END AS movement_fallback

              FROM public.transactions
                AS transaction_record

              LEFT JOIN ranked_movements
                AS movement

                ON movement.transaction_id =
                  transaction_record.id

                AND movement.row_position = 1

              WHERE transaction_record.merchant_id =
                  ${merchantId}::uuid

                AND upper(
                  transaction_record.currency
                ) = ${currency}

                AND lower(
                  transaction_record.status
                ) = 'succeeded'
            )

            SELECT
              COUNT(*) FILTER (
                WHERE
                  (
                    created_at
                    AT TIME ZONE
                      'Europe/Lisbon'
                  )::date =
                  (
                    now()
                    AT TIME ZONE
                      'Europe/Lisbon'
                  )::date
              )::int
                AS today_transactions,

              COALESCE(
                SUM(amount) FILTER (
                  WHERE
                    (
                      created_at
                      AT TIME ZONE
                        'Europe/Lisbon'
                    )::date =
                    (
                      now()
                      AT TIME ZONE
                        'Europe/Lisbon'
                    )::date
                ),
                0
              )
                AS today_gross,

              COALESCE(
                SUM(canonical_net) FILTER (
                  WHERE
                    (
                      created_at
                      AT TIME ZONE
                        'Europe/Lisbon'
                    )::date =
                    (
                      now()
                      AT TIME ZONE
                        'Europe/Lisbon'
                    )::date
                ),
                0
              )
                AS today_net,

              COUNT(*) FILTER (
                WHERE
                  (
                    created_at
                    AT TIME ZONE
                      'Europe/Lisbon'
                  ) >=
                  date_trunc(
                    'month',
                    now()
                    AT TIME ZONE
                      'Europe/Lisbon'
                  )
              )::int
                AS month_transactions,

              COALESCE(
                SUM(amount) FILTER (
                  WHERE
                    (
                      created_at
                      AT TIME ZONE
                        'Europe/Lisbon'
                    ) >=
                    date_trunc(
                      'month',
                      now()
                      AT TIME ZONE
                        'Europe/Lisbon'
                    )
                ),
                0
              )
                AS month_gross,

              COALESCE(
                SUM(canonical_net) FILTER (
                  WHERE
                    (
                      created_at
                      AT TIME ZONE
                        'Europe/Lisbon'
                    ) >=
                    date_trunc(
                      'month',
                      now()
                      AT TIME ZONE
                        'Europe/Lisbon'
                    )
                ),
                0
              )
                AS month_net,

              COUNT(*)::int
                AS total_transactions,

              COALESCE(
                SUM(amount),
                0
              )
                AS total_gross,

              COALESCE(
                SUM(canonical_net),
                0
              )
                AS total_net,

              COALESCE(
                SUM(movement_fallback),
                0
              )::int
                AS movement_fallback_count

            FROM canonical_transactions
          `
        ),

        prisma.$queryRaw<
          DatabaseRow[]
        >(
          Prisma.sql`
            SELECT
              id::text,
              balance,
              reconciliation_hold

            FROM public.wallets

            WHERE merchant_id =
              ${merchantId}::uuid

              AND upper(currency) =
                ${currency}

            LIMIT 1
          `
        ),

        prisma.$queryRaw<
          DatabaseRow[]
        >(
          Prisma.sql`
            SELECT
              COUNT(*) FILTER (
                WHERE lower(status) =
                  'paid'
              )::int
                AS paid_count,

              COALESCE(
                SUM(amount) FILTER (
                  WHERE lower(status) =
                    'paid'
                ),
                0
              )
                AS paid_amount

            FROM public.payout_statements

            WHERE merchant_id =
              ${merchantId}::uuid

              AND upper(currency) =
                ${currency}
          `
        ),

        prisma.$queryRaw<
          DatabaseRow[]
        >(
          Prisma.sql`
            SELECT
              COALESCE(
                SUM(
                  CASE
                    WHEN lower(direction)
                      IN (
                        'in',
                        'credit',
                        'release'
                      )

                    THEN amount

                    WHEN lower(direction)
                      IN (
                        'out',
                        'debit',
                        'hold'
                      )

                    THEN -amount

                    ELSE 0
                  END
                ),
                0
              ) AS adjustment_amount

            FROM public.wallet_movements

            WHERE merchant_id =
              ${merchantId}::uuid

              AND upper(currency) =
                ${currency}

              AND type NOT IN (
                'payment',
                'payout'
              )

              AND lower(status) NOT IN (
                'superseded',
                'cancelled',
                'canceled',
                'failed',
                'reversed',
                'inactive'
              )
          `
        ),

        prisma.$queryRaw<
          DatabaseRow[]
        >(
          Prisma.sql`
            WITH ranked_movements AS (
              SELECT
                movement.*,

                ROW_NUMBER() OVER (
                  PARTITION BY
                    movement.transaction_id

                  ORDER BY
                    movement.updated_at DESC,
                    movement.created_at DESC,
                    movement.id DESC
                ) AS row_position

              FROM public.wallet_movements
                AS movement

              WHERE movement.merchant_id =
                  ${merchantId}::uuid

                AND movement.type =
                  'payment'

                AND movement.direction =
                  'in'

                AND movement.transaction_id
                  IS NOT NULL
            ),

            canonical_transactions AS (
              SELECT
                transaction_record.id,
                transaction_record.store_id,
                transaction_record.created_at,
                transaction_record.amount,

                COALESCE(
                  movement.merchant_net,

                  CASE
                    WHEN movement.provider_net
                      IS NOT NULL

                    THEN
                      movement.provider_net -
                      COALESCE(
                        movement.platform_fee,
                        0
                      )
                  END,

                  CASE
                    WHEN movement.amount
                      IS NOT NULL

                    THEN
                      movement.amount -
                      COALESCE(
                        movement.provider_fee,
                        0
                      )
                  END,

                  transaction_record.amount -
                  COALESCE(
                    transaction_record.fee,
                    0
                  )
                ) AS canonical_net

              FROM public.transactions
                AS transaction_record

              LEFT JOIN ranked_movements
                AS movement

                ON movement.transaction_id =
                  transaction_record.id

                AND movement.row_position = 1

              WHERE transaction_record.merchant_id =
                  ${merchantId}::uuid

                AND upper(
                  transaction_record.currency
                ) = ${currency}

                AND lower(
                  transaction_record.status
                ) = 'succeeded'
            ),

            sales_totals AS (
              SELECT
                store_id,

                COUNT(*) FILTER (
                  WHERE
                    (
                      created_at
                      AT TIME ZONE
                        'Europe/Lisbon'
                    )::date =
                    (
                      now()
                      AT TIME ZONE
                        'Europe/Lisbon'
                    )::date
                )::int
                  AS today_transactions,

                COALESCE(
                  SUM(amount) FILTER (
                    WHERE
                      (
                        created_at
                        AT TIME ZONE
                          'Europe/Lisbon'
                      )::date =
                      (
                        now()
                        AT TIME ZONE
                          'Europe/Lisbon'
                      )::date
                  ),
                  0
                )
                  AS today_gross,

                COALESCE(
                  SUM(canonical_net) FILTER (
                    WHERE
                      (
                        created_at
                        AT TIME ZONE
                          'Europe/Lisbon'
                      )::date =
                      (
                        now()
                        AT TIME ZONE
                          'Europe/Lisbon'
                      )::date
                  ),
                  0
                )
                  AS today_net,

                COUNT(*) FILTER (
                  WHERE
                    (
                      created_at
                      AT TIME ZONE
                        'Europe/Lisbon'
                    ) >=
                    date_trunc(
                      'month',
                      now()
                      AT TIME ZONE
                        'Europe/Lisbon'
                    )
                )::int
                  AS month_transactions,

                COALESCE(
                  SUM(amount) FILTER (
                    WHERE
                      (
                        created_at
                        AT TIME ZONE
                          'Europe/Lisbon'
                      ) >=
                      date_trunc(
                        'month',
                        now()
                        AT TIME ZONE
                          'Europe/Lisbon'
                      )
                  ),
                  0
                )
                  AS month_gross,

                COALESCE(
                  SUM(canonical_net) FILTER (
                    WHERE
                      (
                        created_at
                        AT TIME ZONE
                          'Europe/Lisbon'
                      ) >=
                      date_trunc(
                        'month',
                        now()
                        AT TIME ZONE
                          'Europe/Lisbon'
                      )
                  ),
                  0
                )
                  AS month_net,

                COUNT(*)::int
                  AS total_transactions,

                COALESCE(
                  SUM(amount),
                  0
                )
                  AS total_gross,

                COALESCE(
                  SUM(canonical_net),
                  0
                )
                  AS total_net

              FROM canonical_transactions

              GROUP BY store_id
            ),

            payout_totals AS (
              SELECT
                allocation.store_id,

                COUNT(
                  DISTINCT statement.id
                ) FILTER (
                  WHERE lower(
                    statement.status
                  ) = 'paid'
                )::int
                  AS paid_count,

                COALESCE(
                  SUM(
                    allocation.amount
                  ) FILTER (
                    WHERE lower(
                      statement.status
                    ) = 'paid'
                  ),
                  0
                )
                  AS paid_amount

              FROM public
                .payout_statement_allocations
                  AS allocation

              JOIN public.payout_statements
                AS statement

                ON statement.id =
                  allocation
                    .payout_statement_id

              WHERE statement.merchant_id =
                ${merchantId}::uuid

                AND upper(
                  statement.currency
                ) = ${currency}

              GROUP BY
                allocation.store_id
            ),

            adjustment_totals AS (
              SELECT
                store_id,

                COALESCE(
                  SUM(
                    CASE
                      WHEN lower(direction)
                        IN (
                          'in',
                          'credit',
                          'release'
                        )

                      THEN amount

                      WHEN lower(direction)
                        IN (
                          'out',
                          'debit',
                          'hold'
                        )

                      THEN -amount

                      ELSE 0
                    END
                  ),
                  0
                )
                  AS adjustment_amount

              FROM public.wallet_movements

              WHERE merchant_id =
                ${merchantId}::uuid

                AND upper(currency) =
                  ${currency}

                AND store_id
                  IS NOT NULL

                AND type NOT IN (
                  'payment',
                  'payout'
                )

                AND lower(status) NOT IN (
                  'superseded',
                  'cancelled',
                  'canceled',
                  'failed',
                  'reversed',
                  'inactive'
                )

              GROUP BY store_id
            )

            SELECT
              store.id::text
                AS store_id,

              store.store_code,
              store.name
                AS store_name,

              store.status,

              store.currency
                AS configured_currency,

              COALESCE(
                sales_totals
                  .today_transactions,
                0
              )
                AS today_transactions,

              COALESCE(
                sales_totals
                  .today_gross,
                0
              )
                AS today_gross,

              COALESCE(
                sales_totals
                  .today_net,
                0
              )
                AS today_net,

              COALESCE(
                sales_totals
                  .month_transactions,
                0
              )
                AS month_transactions,

              COALESCE(
                sales_totals
                  .month_gross,
                0
              )
                AS month_gross,

              COALESCE(
                sales_totals
                  .month_net,
                0
              )
                AS month_net,

              COALESCE(
                sales_totals
                  .total_transactions,
                0
              )
                AS total_transactions,

              COALESCE(
                sales_totals
                  .total_gross,
                0
              )
                AS total_gross,

              COALESCE(
                sales_totals
                  .total_net,
                0
              )
                AS total_net,

              COALESCE(
                payout_totals
                  .paid_count,
                0
              )
                AS paid_payout_count,

              COALESCE(
                payout_totals
                  .paid_amount,
                0
              )
                AS paid_payout_amount,

              COALESCE(
                adjustment_totals
                  .adjustment_amount,
                0
              )
                AS adjustment_amount,

              (
                COALESCE(
                  sales_totals
                    .total_net,
                  0
                )
                -
                COALESCE(
                  payout_totals
                    .paid_amount,
                  0
                )
                +
                COALESCE(
                  adjustment_totals
                    .adjustment_amount,
                  0
                )
              )
                AS wallet_balance

            FROM public.stores
              AS store

            LEFT JOIN sales_totals

              ON sales_totals.store_id =
                store.id

            LEFT JOIN payout_totals

              ON payout_totals.store_id =
                store.id

            LEFT JOIN adjustment_totals

              ON adjustment_totals.store_id =
                store.id

            WHERE store.merchant_id =
              ${merchantId}::uuid

              AND (
                upper(store.currency) =
                  ${currency}

                OR sales_totals.store_id
                  IS NOT NULL

                OR payout_totals.store_id
                  IS NOT NULL

                OR adjustment_totals.store_id
                  IS NOT NULL
              )

            ORDER BY
              wallet_balance DESC,
              store.store_code
          `
        )
      ]);

      const merchantSales =
        merchantSalesRows[0] || {};

      const physicalWallet =
        walletRows[0] || {};

      const merchantPayouts =
        merchantPayoutRows[0] || {};

      const merchantAdjustments =
        merchantAdjustmentRows[0] || {};

      const merchantGrossTotal =
        money(
          merchantSales.total_gross
        );

      const merchantNetTotal =
        money(
          merchantSales.total_net
        );

      const paidPayoutAmount =
        money(
          merchantPayouts
            .paid_amount
        );

      const adjustmentAmount =
        money(
          merchantAdjustments
            .adjustment_amount
        );

      const canonicalWalletBalance =
        money(
          merchantNetTotal -
          paidPayoutAmount +
          adjustmentAmount
        );

      const physicalAccountingBalance =
        money(
          physicalWallet.balance
        );

      const physicalHold =
        money(
          physicalWallet
            .reconciliation_hold
        );

      const physicalOperationalBalance =
        subtract(
          physicalAccountingBalance,
          physicalHold
        );

      const stores =
        storeRows.map(
          row => ({
            storeId:
              row.store_id,

            storeCode:
              row.store_code,

            storeName:
              row.store_name,

            status:
              row.status,

            currency,

            configuredCurrency:
              row.configured_currency,

            grossSales: {
              today:
                money(
                  row.today_gross
                ),

              month:
                money(
                  row.month_gross
                ),

              total:
                money(
                  row.total_gross
                )
            },

            netSales: {
              today:
                money(
                  row.today_net
                ),

              month:
                money(
                  row.month_net
                ),

              total:
                money(
                  row.total_net
                )
            },

            wallet: {
              balance:
                money(
                  row.wallet_balance
                )
            },

            transactions: {
              today:
                integer(
                  row.today_transactions
                ),

              month:
                integer(
                  row.month_transactions
                ),

              total:
                integer(
                  row.total_transactions
                )
            },

            payouts: {
              paid:
                money(
                  row.paid_payout_amount
                ),

              paidCount:
                integer(
                  row.paid_payout_count
                )
            }
          })
        );

      const storesGrossTotal =
        money(
          stores.reduce(
            (
              total,
              store
            ) =>
              total +
              store.grossSales.total,
            0
          )
        );

      const storesNetTotal =
        money(
          stores.reduce(
            (
              total,
              store
            ) =>
              total +
              store.netSales.total,
            0
          )
        );

      const storesWalletTotal =
        money(
          stores.reduce(
            (
              total,
              store
            ) =>
              total +
              store.wallet.balance,
            0
          )
        );

      const grossDifference =
        subtract(
          merchantGrossTotal,
          storesGrossTotal
        );

      const netDifference =
        subtract(
          merchantNetTotal,
          storesNetTotal
        );

      const walletDifference =
        subtract(
          canonicalWalletBalance,
          storesWalletTotal
        );

      const physicalLedgerDifference =
        subtract(
          physicalOperationalBalance,
          canonicalWalletBalance
        );

      const movementFallbackCount =
        integer(
          merchantSales
            .movement_fallback_count
        );

      const aggregationBalanced =
        grossDifference === 0 &&
        netDifference === 0 &&
        walletDifference === 0;

      const physicalLedgerBalanced =
        physicalLedgerDifference === 0;

      if (
        !aggregationBalanced ||
        !physicalLedgerBalanced ||
        movementFallbackCount > 0
      ) {
        console.warn(
          '[FINANCE-DASHBOARD-V2] reconciliation attention',
          {
            merchantId,
            currency,
            grossDifference,
            netDifference,
            walletDifference,
            physicalLedgerDifference,
            movementFallbackCount
          }
        );
      }

      return res.json({
        success: true,

        data: {
          version:
            'finance-dashboard-v2',

          currency,

          timezone:
            FINANCE_TIMEZONE,

          generatedAt:
            new Date()
              .toISOString(),

          merchant: {
            grossSales: {
              today:
                money(
                  merchantSales
                    .today_gross
                ),

              month:
                money(
                  merchantSales
                    .month_gross
                ),

              total:
                merchantGrossTotal
            },

            netSales: {
              today:
                money(
                  merchantSales
                    .today_net
                ),

              month:
                money(
                  merchantSales
                    .month_net
                ),

              total:
                merchantNetTotal
            },

            wallet: {
              balance:
                canonicalWalletBalance
            },

            transactions: {
              today:
                integer(
                  merchantSales
                    .today_transactions
                ),

              month:
                integer(
                  merchantSales
                    .month_transactions
                ),

              total:
                integer(
                  merchantSales
                    .total_transactions
                )
            },

            payouts: {
              paid:
                paidPayoutAmount,

              paidCount:
                integer(
                  merchantPayouts
                    .paid_count
                )
            }
          },

          stores,

          reconciliation: {
            aggregation: {
              status:
                aggregationBalanced
                  ? 'balanced'
                  : 'attention',

              grossDifference,
              netDifference,
              walletDifference
            },

            physicalLedger: {
              status:
                physicalLedgerBalanced
                  ? 'balanced'
                  : 'attention',

              difference:
                physicalLedgerDifference
            },

            movementFallbackCount
          }
        }
      });
    } catch (error) {
      return internalError(
        res,
        error
      );
    }
  };
