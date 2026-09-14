import { Response } from 'express';
import { Prisma } from '@prisma/client';

import prisma from '../../../core/prisma';
import { AuthRequest } from '../../../middleware/auth.middleware';

type DatabaseRow = Record<string, any>;

const FINANCE_TIMEZONE = 'Europe/Lisbon';

const toNumber = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed)
    ? Math.round((parsed + Number.EPSILON) * 100) / 100
    : 0;
};

const toCount = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const toDate = (value: unknown): string | null => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
};

const getMerchantId = (req: AuthRequest): string | null =>
  req.merchantId || req.user?.id || null;

const getCurrency = (req: AuthRequest): string => {
  const candidate =
    typeof req.query.currency === 'string'
      ? req.query.currency.trim().toUpperCase()
      : 'EUR';

  return /^[A-Z]{3,5}$/.test(candidate)
    ? candidate
    : 'EUR';
};

export const getFinanceReleasesV2 = async (
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
    const rows = await prisma.$queryRaw<DatabaseRow[]>(
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
          ) AS release_date,

          store.id AS store_id,
          store.store_code,
          store.name AS store_name,

          MAX(transaction_record.gateway)
            AS gateway,

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
          ) AS net,

          COUNT(movement.id) FILTER (
            WHERE lower(
              COALESCE(
                movement.provider_balance_status,
                ''
              )
            ) = 'available'
          ) AS provider_available_count,

          COUNT(movement.id) FILTER (
            WHERE lower(
              COALESCE(
                movement.provider_balance_status,
                ''
              )
            ) = 'pending'
          ) AS provider_pending_count,

          MAX(movement.provider_synced_at)
            AS provider_synced_at

        FROM public.wallet_movements
          AS movement

        LEFT JOIN public.transactions
          AS transaction_record
          ON transaction_record.id = movement.transaction_id

        LEFT JOIN public.stores
          AS store
          ON store.id = movement.store_id

        WHERE movement.merchant_id = ${merchantId}::uuid
          AND upper(movement.currency) = ${currency}
          AND movement.direction = 'in'
          AND movement.type = 'payment'
          AND movement.status = 'pendente'
          AND COALESCE(
            movement.manual_estimated_release_on,
            movement.provider_available_on,
            movement.system_estimated_release_on,
            (
              movement.expected_release_at
              AT TIME ZONE 'Europe/Lisbon'
            )::date
          ) IS NOT NULL

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
          release_date,
          store.store_code
      `
    );

    const today = new Intl.DateTimeFormat(
      'en-CA',
      {
        timeZone: FINANCE_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }
    ).format(new Date());

    const items = rows.map(row => {
      const releaseDate = toDate(row.release_date);
      const movementCount = toCount(row.movement_count);
      const availableCount = toCount(row.provider_available_count);
      const pendingCount = toCount(row.provider_pending_count);

      let providerStatus: 'available' | 'pending' | 'unknown' = 'unknown';

      if (
        movementCount > 0 &&
        availableCount === movementCount
      ) {
        providerStatus = 'available';
      } else if (pendingCount > 0) {
        providerStatus = 'pending';
      }

      const legacyStatus =
        releaseDate && releaseDate < today
          ? 'overdue'
          : 'expected';

      return {
        date: releaseDate,
        storeId: row.store_id || null,
        storeCode: row.store_code || null,
        storeName: row.store_name || null,
        gateway: row.gateway || null,
        gross: toNumber(row.gross),
        fees: toNumber(row.fees),
        net: toNumber(row.net),
        amount: toNumber(row.net),
        movementCount,
        status: legacyStatus,
        providerStatus,
        operationalStatus:
          providerStatus === 'available'
            ? 'awaiting_admin'
            : 'expected',
        providerSyncedAt:
          row.provider_synced_at instanceof Date
            ? row.provider_synced_at.toISOString()
            : row.provider_synced_at
              ? String(row.provider_synced_at)
              : null
      };
    });

    const totalNet = toNumber(
      items.reduce(
        (total, item) => total + item.net,
        0
      )
    );

    const overdueNet = toNumber(
      items
        .filter(item => item.status === 'overdue')
        .reduce(
          (total, item) => total + item.net,
          0
        )
    );

    const awaitingAdminNet = toNumber(
      items
        .filter(
          item => item.operationalStatus === 'awaiting_admin'
        )
        .reduce(
          (total, item) => total + item.net,
          0
        )
    );

    return res.json({
      success: true,
      data: {
        currency,
        timezone: FINANCE_TIMEZONE,
        items,
        summary: {
          totalNet,
          movementCount: items.reduce(
            (total, item) => total + item.movementCount,
            0
          ),
          overdueNet,
          awaitingAdminNet
        },
        semantics: {
          overdueMeansAvailable: false,
          providerAvailableRequiresAdminValidation: true,
          autoSettlement: false,
          autoFx: false
        },
        generatedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('[FINANCE_RELEASES_V2_ERROR]', error);

    return res.status(500).json({
      success: false,
      error: {
        code: 'FINANCE_QUERY_FAILED',
        message: 'Erro ao carregar previsões de liberação.'
      }
    });
  }
};
