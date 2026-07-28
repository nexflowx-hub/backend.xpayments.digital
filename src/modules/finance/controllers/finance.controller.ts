import { Response } from 'express';
import { Prisma } from '@prisma/client';

import prisma from '../../../core/prisma';
import { AuthRequest } from '../../../middleware/auth.middleware';

type DatabaseRow = Record<string, any>;

const FINANCE_TIMEZONE = 'Europe/Lisbon';

const toNumber = (value: unknown): number => {
  if (value === null || value === undefined) {
    return 0;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed)
    ? Math.round((parsed + Number.EPSILON) * 100) / 100
    : 0;
};

const toCount = (value: unknown): number => {
  const parsed = Number(value);

  return Number.isFinite(parsed)
    ? parsed
    : 0;
};

const toDate = (value: unknown): string | null => {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  return String(value).slice(0, 10);
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

const getCurrency = (
  req: AuthRequest
): string => {
  const candidate =
    typeof req.query.currency === 'string'
      ? req.query.currency.trim().toUpperCase()
      : 'EUR';

  return /^[A-Z]{3,5}$/.test(candidate)
    ? candidate
    : 'EUR';
};

const internalError = (
  res: Response,
  error: unknown,
  message: string
) => {
  console.error(
    `[FINANCE] ${message}`,
    error
  );

  return res.status(500).json({
    success: false,
    error: {
      code: 'FINANCE_QUERY_FAILED',
      message
    }
  });
};

export const getFinanceOverview = async (
  req: AuthRequest,
  res: Response
) => {
  const merchantId = getMerchantId(req);

  if (!merchantId) {
    return res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHENTICATED',
        message: 'Merchant não autenticado.'
      }
    });
  }

  const currency = getCurrency(req);

  try {
    const salesRows =
      await prisma.$queryRaw<DatabaseRow[]>(
        Prisma.sql`
          SELECT
            COUNT(*) FILTER (
              WHERE
                (
                  created_at
                  AT TIME ZONE 'Europe/Lisbon'
                )::date =
                (
                  now()
                  AT TIME ZONE 'Europe/Lisbon'
                )::date
            ) AS today_count,

            COALESCE(
              SUM(amount) FILTER (
                WHERE
                  (
                    created_at
                    AT TIME ZONE 'Europe/Lisbon'
                  )::date =
                  (
                    now()
                    AT TIME ZONE 'Europe/Lisbon'
                  )::date
              ),
              0
            ) AS today_gross,

            COALESCE(
              SUM(
                COALESCE(fee, 0)
              ) FILTER (
                WHERE
                  (
                    created_at
                    AT TIME ZONE 'Europe/Lisbon'
                  )::date =
                  (
                    now()
                    AT TIME ZONE 'Europe/Lisbon'
                  )::date
              ),
              0
            ) AS today_fees,

            COUNT(*) FILTER (
              WHERE
                (
                  created_at
                  AT TIME ZONE 'Europe/Lisbon'
                ) >=
                date_trunc(
                  'week',
                  now()
                  AT TIME ZONE 'Europe/Lisbon'
                )
            ) AS week_count,

            COALESCE(
              SUM(amount) FILTER (
                WHERE
                  (
                    created_at
                    AT TIME ZONE 'Europe/Lisbon'
                  ) >=
                  date_trunc(
                    'week',
                    now()
                    AT TIME ZONE 'Europe/Lisbon'
                  )
              ),
              0
            ) AS week_gross,

            COALESCE(
              SUM(
                COALESCE(fee, 0)
              ) FILTER (
                WHERE
                  (
                    created_at
                    AT TIME ZONE 'Europe/Lisbon'
                  ) >=
                  date_trunc(
                    'week',
                    now()
                    AT TIME ZONE 'Europe/Lisbon'
                  )
              ),
              0
            ) AS week_fees,

            COUNT(*) FILTER (
              WHERE
                (
                  created_at
                  AT TIME ZONE 'Europe/Lisbon'
                ) >=
                date_trunc(
                  'month',
                  now()
                  AT TIME ZONE 'Europe/Lisbon'
                )
            ) AS month_count,

            COALESCE(
              SUM(amount) FILTER (
                WHERE
                  (
                    created_at
                    AT TIME ZONE 'Europe/Lisbon'
                  ) >=
                  date_trunc(
                    'month',
                    now()
                    AT TIME ZONE 'Europe/Lisbon'
                  )
              ),
              0
            ) AS month_gross,

            COALESCE(
              SUM(
                COALESCE(fee, 0)
              ) FILTER (
                WHERE
                  (
                    created_at
                    AT TIME ZONE 'Europe/Lisbon'
                  ) >=
                  date_trunc(
                    'month',
                    now()
                    AT TIME ZONE 'Europe/Lisbon'
                  )
              ),
              0
            ) AS month_fees,

            COUNT(*) AS all_time_count,

            COALESCE(
              SUM(amount),
              0
            ) AS all_time_gross,

            COALESCE(
              SUM(
                COALESCE(fee, 0)
              ),
              0
            ) AS all_time_fees

          FROM public.transactions

          WHERE merchant_id =
            ${merchantId}::uuid

            AND upper(currency) =
              ${currency}

            AND lower(status) =
              'succeeded'
        `
      );

    const walletRows =
      await prisma.$queryRaw<DatabaseRow[]>(
        Prisma.sql`
          SELECT
            id,
            currency,
            balance,
            available,
            reserved,
            reconciliation_hold,

            (
              balance -
              available -
              reserved -
              reconciliation_hold
            ) AS pending,

            (
              balance -
              reconciliation_hold
            ) AS merchant_wallet

          FROM public.wallets

          WHERE merchant_id =
            ${merchantId}::uuid

            AND upper(currency) =
              ${currency}

          LIMIT 1
        `
      );

    const payoutRows =
      await prisma.$queryRaw<DatabaseRow[]>(
        Prisma.sql`
          SELECT
            COALESCE(
              SUM(amount) FILTER (
                WHERE status = 'paid'
              ),
              0
            ) AS paid,

            COALESCE(
              SUM(amount) FILTER (
                WHERE status IN (
                  'scheduled',
                  'processing'
                )
              ),
              0
            ) AS scheduled,

            COUNT(*) FILTER (
              WHERE status = 'paid'
            ) AS paid_count,

            COUNT(*) FILTER (
              WHERE status IN (
                'scheduled',
                'processing'
              )
            ) AS scheduled_count

          FROM public.payout_statements

          WHERE merchant_id =
            ${merchantId}::uuid

            AND upper(currency) =
              ${currency}
        `
      );

    const nextReleaseRows =
      await prisma.$queryRaw<DatabaseRow[]>(
        Prisma.sql`
          WITH first_release AS (
            SELECT
              COALESCE(
                manual_estimated_release_on,
                provider_available_on,
                system_estimated_release_on,
                (
                  expected_release_at
                  AT TIME ZONE 'Europe/Lisbon'
                )::date
              ) AS release_date

            FROM public.wallet_movements

            WHERE merchant_id =
              ${merchantId}::uuid

              AND upper(currency) =
                ${currency}

              AND direction = 'in'
              AND type = 'payment'
              AND status = 'pendente'
              AND expected_release_at IS NOT NULL

            ORDER BY
              COALESCE(
                manual_estimated_release_on,
                provider_available_on,
                system_estimated_release_on,
                (
                  expected_release_at
                  AT TIME ZONE 'Europe/Lisbon'
                )::date
              )
            LIMIT 1
          )

          SELECT
            first_release.release_date,

            COALESCE(
              SUM(movement.amount),
              0
            ) AS amount,

            COUNT(movement.id)
              AS movement_count

          FROM first_release

          JOIN public.wallet_movements
            AS movement

            ON COALESCE(
              movement.manual_estimated_release_on,
              movement.provider_available_on,
              movement.system_estimated_release_on,
              (
                movement.expected_release_at
                AT TIME ZONE 'Europe/Lisbon'
              )::date
            ) =
              first_release.release_date

            AND movement.merchant_id =
              ${merchantId}::uuid

            AND upper(movement.currency) =
              ${currency}

            AND movement.direction = 'in'
            AND movement.type = 'payment'
            AND movement.status = 'pendente'

          GROUP BY first_release.release_date
        `
      );

    const sales =
      salesRows[0] || {};

    const wallet =
      walletRows[0] || {};

    const payouts =
      payoutRows[0] || {};

    const nextRelease =
      nextReleaseRows[0] || null;

    const buildPeriod = (
      grossValue: unknown,
      feeValue: unknown,
      countValue: unknown
    ) => {
      const gross =
        toNumber(grossValue);

      const fees =
        toNumber(feeValue);

      return {
        gross,
        fees,
        net:
          toNumber(gross - fees),
        transactions:
          toCount(countValue)
      };
    };

    const available =
      toNumber(wallet.available);

    const scheduled =
      toNumber(payouts.scheduled);

    const releaseDate =
      nextRelease
        ? toDate(nextRelease.release_date)
        : null;

    const today =
      new Intl.DateTimeFormat(
        'en-CA',
        {
          timeZone: FINANCE_TIMEZONE,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit'
        }
      ).format(new Date());

    return res.json({
      success: true,
      data: {
        currency,
        timezone: FINANCE_TIMEZONE,

        sales: {
          today: buildPeriod(
            sales.today_gross,
            sales.today_fees,
            sales.today_count
          ),

          week: buildPeriod(
            sales.week_gross,
            sales.week_fees,
            sales.week_count
          ),

          month: buildPeriod(
            sales.month_gross,
            sales.month_fees,
            sales.month_count
          ),

          allTime: buildPeriod(
            sales.all_time_gross,
            sales.all_time_fees,
            sales.all_time_count
          )
        },

                wallet: {
          id:
            wallet.id || null,

          balance:
            toNumber(
              wallet.merchant_wallet
            ),

          pending:
            toNumber(
              wallet.pending
            ),

          available,

          reserved:
            toNumber(
              wallet.reserved
            )
        },

        payouts: {
          scheduled,
          scheduledCount:
            toCount(
              payouts.scheduled_count
            ),

          paid:
            toNumber(
              payouts.paid
            ),

          paidCount:
            toCount(
              payouts.paid_count
            )
        },

        projectedAvailable:
          toNumber(
            available - scheduled
          ),

        nextRelease:
          nextRelease
            ? {
                date: releaseDate,

                amount:
                  toNumber(
                    nextRelease.amount
                  ),

                movementCount:
                  toCount(
                    nextRelease.movement_count
                  ),

                status:
                  releaseDate &&
                  releaseDate < today
                    ? 'overdue'
                    : 'expected'
              }
            : null,

        generatedAt:
          new Date().toISOString()
      }
    });
  } catch (error) {
    return internalError(
      res,
      error,
      'Erro ao carregar visão financeira.'
    );
  }
};

export const getFinanceStores = async (
  req: AuthRequest,
  res: Response
) => {
  const merchantId = getMerchantId(req);

  if (!merchantId) {
    return res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHENTICATED',
        message: 'Merchant não autenticado.'
      }
    });
  }

  const currency = getCurrency(req);

  try {
    const rows =
      await prisma.$queryRaw<DatabaseRow[]>(
        Prisma.sql`
          WITH transaction_totals AS (
            SELECT
              store_id,

              COUNT(*) AS transaction_count,

              COALESCE(
                SUM(amount),
                0
              ) AS gross,

              COALESCE(
                SUM(
                  COALESCE(fee, 0)
                ),
                0
              ) AS fees,

              COALESCE(
                SUM(
                  amount -
                  COALESCE(fee, 0)
                ),
                0
              ) AS net

            FROM public.transactions

            WHERE merchant_id =
              ${merchantId}::uuid

              AND upper(currency) =
                ${currency}

              AND lower(status) =
                'succeeded'

            GROUP BY store_id
          ),

          movement_totals AS (
            SELECT
              store_id,

              COALESCE(
                SUM(amount) FILTER (
                  WHERE
                    direction = 'in'
                    AND type = 'payment'
                    AND status = 'pendente'
                ),
                0
              ) AS pending,

              COALESCE(
                SUM(amount) FILTER (
                  WHERE
                    direction = 'in'
                    AND type = 'payment'
                    AND status = 'disponivel'
                ),
                0
              ) AS released,

              COALESCE(
                SUM(amount) FILTER (
                  WHERE
                    direction = 'in'
                    AND type = 'payment'
                    AND status =
                      'reconciliation_hold'
                ),
                0
              ) AS reconciliation_hold,

              COALESCE(
                SUM(amount) FILTER (
                  WHERE
                    direction = 'hold'
                    AND type =
                      'fee_reconciliation'
                    AND status = 'active'
                ),
                0
              ) AS fee_reconciliation_hold

            FROM public.wallet_movements

            WHERE merchant_id =
              ${merchantId}::uuid

              AND upper(currency) =
                ${currency}

            GROUP BY store_id
          ),

          payout_totals AS (
            SELECT
              allocation.store_id,

              COALESCE(
                SUM(allocation.amount) FILTER (
                  WHERE payout.status = 'paid'
                ),
                0
              ) AS paid_payouts,

              COALESCE(
                SUM(allocation.amount) FILTER (
                  WHERE payout.status IN (
                    'scheduled',
                    'processing'
                  )
                ),
                0
              ) AS scheduled_payouts

            FROM
              public.payout_statement_allocations
                AS allocation

            JOIN public.payout_statements
              AS payout

              ON payout.id =
                allocation.payout_statement_id

            WHERE payout.merchant_id =
              ${merchantId}::uuid

              AND upper(payout.currency) =
                ${currency}

            GROUP BY allocation.store_id
          )

          SELECT
            store.id,
            store.store_code,
            store.name,
            store.status,
            store.currency,

            COALESCE(
              transaction_totals.transaction_count,
              0
            ) AS transaction_count,

            COALESCE(
              transaction_totals.gross,
              0
            ) AS gross,

            COALESCE(
              transaction_totals.fees,
              0
            ) AS fees,

            COALESCE(
              transaction_totals.net,
              0
            ) AS net,

            COALESCE(
              movement_totals.pending,
              0
            ) AS pending,

            COALESCE(
              movement_totals.released,
              0
            ) AS released,

            COALESCE(
              movement_totals.reconciliation_hold,
              0
            ) AS reconciliation_hold,

            COALESCE(
              payout_totals.paid_payouts,
              0
            ) AS paid_payouts,

            COALESCE(
              payout_totals.scheduled_payouts,
              0
            ) AS scheduled_payouts,

            (
              COALESCE(
                transaction_totals.net,
                0
              ) -
              COALESCE(
                payout_totals.paid_payouts,
                0
              )
            ) AS operational_balance,

            GREATEST(
              (
                COALESCE(
                  movement_totals.released,
                  0
                ) -
                COALESCE(
                  payout_totals.paid_payouts,
                  0
                ) -
                COALESCE(
                  movement_totals.fee_reconciliation_hold,
                  0
                )
              ),
              0
            ) AS available_after_payouts

          FROM public.stores
            AS store

          LEFT JOIN transaction_totals
            ON transaction_totals.store_id =
              store.id

          LEFT JOIN movement_totals
            ON movement_totals.store_id =
              store.id

          LEFT JOIN payout_totals
            ON payout_totals.store_id =
              store.id

          WHERE store.merchant_id =
            ${merchantId}::uuid

            AND upper(store.currency) =
              ${currency}

          ORDER BY
            transaction_totals.net
              DESC NULLS LAST,
            store.store_code
        `
      );

    const stores =
      rows.map(row => ({
        storeId:
          row.id,

        storeCode:
          row.store_code,

        storeName:
          row.name,

        status:
          row.status,

        currency:
          row.currency,

        transactions:
          toCount(
            row.transaction_count
          ),

        gross:
          toNumber(row.gross),

        fees:
          toNumber(row.fees),

        net:
          toNumber(row.net),

        pending:
          toNumber(row.pending),

        released:
          toNumber(row.released),

        paidPayouts:
          toNumber(
            row.paid_payouts
          ),

        scheduledPayouts:
          toNumber(
            row.scheduled_payouts
          ),

        operationalBalance:
          toNumber(
            row.operational_balance
          ),

        availableAfterPayouts:
          toNumber(
            row.available_after_payouts
          )
      }));

    return res.json({
      success: true,
      data: {
        currency,
        stores,
        generatedAt:
          new Date().toISOString()
      }
    });
  } catch (error) {
    return internalError(
      res,
      error,
      'Erro ao carregar fluxo por Store.'
    );
  }
};

export const getFinanceReleases = async (
  req: AuthRequest,
  res: Response
) => {
  const merchantId = getMerchantId(req);

  if (!merchantId) {
    return res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHENTICATED',
        message: 'Merchant não autenticado.'
      }
    });
  }

  const currency = getCurrency(req);

  try {
    const rows =
      await prisma.$queryRaw<DatabaseRow[]>(
        Prisma.sql`
          SELECT
            COALESCE(
              movement.manual_estimated_release_on,
              movement.provider_available_on,
              movement.system_estimated_release_on,
              (
                movement.expected_release_at
                AT TIME ZONE 'Europe/Lisbon'
              )::date
            )
              AS release_date,

            store.id
              AS store_id,

            store.store_code,
            store.name
              AS store_name,

            COUNT(movement.id)
              AS movement_count,

            COALESCE(
              SUM(transaction_record.amount),
              0
            ) AS gross,

            COALESCE(
              SUM(
                COALESCE(
                  transaction_record.fee,
                  0
                )
              ),
              0
            ) AS fees,

            COALESCE(
              SUM(movement.amount),
              0
            ) AS net

          FROM public.wallet_movements
            AS movement

          LEFT JOIN public.transactions
            AS transaction_record

            ON transaction_record.id =
              movement.transaction_id

          LEFT JOIN public.stores
            AS store

            ON store.id =
              movement.store_id

          WHERE movement.merchant_id =
            ${merchantId}::uuid

            AND upper(movement.currency) =
              ${currency}

            AND movement.direction = 'in'
            AND movement.type = 'payment'
            AND movement.status = 'pendente'

            AND movement.expected_release_at
              IS NOT NULL

          GROUP BY
            COALESCE(
              movement.manual_estimated_release_on,
              movement.provider_available_on,
              movement.system_estimated_release_on,
              (
                movement.expected_release_at
                AT TIME ZONE 'Europe/Lisbon'
              )::date
            ),
            store.id,
            store.store_code,
            store.name

          ORDER BY
            COALESCE(
              movement.manual_estimated_release_on,
              movement.provider_available_on,
              movement.system_estimated_release_on,
              (
                movement.expected_release_at
                AT TIME ZONE 'Europe/Lisbon'
              )::date
            ),
            store.store_code
        `
      );

    const today =
      new Intl.DateTimeFormat(
        'en-CA',
        {
          timeZone: FINANCE_TIMEZONE,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit'
        }
      ).format(new Date());

    const items =
      rows.map(row => {
        const releaseDate =
          toDate(row.release_date);

        return {
          date:
            releaseDate,

          storeId:
            row.store_id || null,

          storeCode:
            row.store_code || null,

          storeName:
            row.store_name || null,

          gross:
            toNumber(row.gross),

          fees:
            toNumber(row.fees),

          net:
            toNumber(row.net),

          movementCount:
            toCount(
              row.movement_count
            ),

          status:
            releaseDate &&
            releaseDate < today
              ? 'overdue'
              : 'expected'
        };
      });

    return res.json({
      success: true,
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
              items
                .filter(
                  item =>
                    item.status ===
                    'overdue'
                )
                .reduce(
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
          new Date().toISOString()
      }
    });
  } catch (error) {
    return internalError(
      res,
      error,
      'Erro ao carregar previsões de liberação.'
    );
  }
};
