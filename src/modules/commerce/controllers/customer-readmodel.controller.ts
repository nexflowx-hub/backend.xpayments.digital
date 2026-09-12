import { Prisma } from '@prisma/client';
import { Response } from 'express';

import prisma from '../../../core/prisma';
import { AuthRequest } from '../../../middleware/auth.middleware';

interface CustomerReadRow {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  normalized_email: string | null;
  normalized_phone: string | null;
  country: string | null;
  legacy_ltv: string | number | null;
  legacy_avg_order: string | number | null;
  orders: number;
  status: string;
  first_seen: Date | string;
  last_seen: Date | string;
  last_payment_at: Date | string | null;
  total_succeeded: number;
  total_failed: number;
  total_refunded: number;
  metrics_by_currency: Record<string, unknown> | null;
}

const getMerchantId = (req: AuthRequest): string | null =>
  req.user?.id ? String(req.user.id) : null;

const toIso = (value: Date | string | null): string | null => {
  if (!value) return null;
  return new Date(value).toISOString();
};

const segmentFor = (
  orders: number,
  lastPaymentAt: Date | string | null
): 'vip' | 'regular' | 'new' | 'at_risk' => {
  if (orders > 0 && lastPaymentAt) {
    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    if (new Date(lastPaymentAt).getTime() < cutoff) {
      return 'at_risk';
    }
  }

  if (orders >= 5) return 'vip';
  if (orders >= 2) return 'regular';
  return 'new';
};

/**
 * CRM read model.
 *
 * Customer identity is Merchant-scoped, while financial metrics are grouped
 * by transaction currency. This deliberately avoids adding BRL + EUR + PLN
 * into one misleading LTV number.
 *
 * `ltv` and `avgOrder` remain in the response for backwards compatibility,
 * but new clients should use `metricsByCurrency`.
 */
export const getCustomersV2 = async (
  req: AuthRequest,
  res: Response
) => {
  try {
    const merchantId = getMerchantId(req);

    if (!merchantId) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Merchant não autenticado.'
        }
      });
    }

    const rows = await prisma.$queryRaw<CustomerReadRow[]>(Prisma.sql`
      WITH currency_metrics AS (
        SELECT
          ctl.customer_id,
          UPPER(t.currency) AS currency,
          COUNT(*) FILTER (
            WHERE LOWER(t.status) = 'succeeded'
          )::int AS orders,
          COALESCE(SUM(t.amount) FILTER (
            WHERE LOWER(t.status) = 'succeeded'
          ), 0) AS ltv,
          COALESCE(AVG(t.amount) FILTER (
            WHERE LOWER(t.status) = 'succeeded'
          ), 0) AS avg_order,
          COUNT(*) FILTER (
            WHERE LOWER(t.status) = 'succeeded'
          )::int AS succeeded,
          COUNT(*) FILTER (
            WHERE LOWER(t.status) = 'failed'
          )::int AS failed,
          COUNT(*) FILTER (
            WHERE LOWER(t.status) = 'refunded'
          )::int AS refunded,
          MAX(t.created_at) FILTER (
            WHERE LOWER(t.status) = 'succeeded'
          ) AS last_payment_at
        FROM customer_transaction_links ctl
        JOIN transactions t
          ON t.id = ctl.transaction_id
        WHERE t.merchant_id = ${merchantId}::uuid
        GROUP BY ctl.customer_id, UPPER(t.currency)
      ), metrics AS (
        SELECT
          customer_id,
          JSONB_OBJECT_AGG(
            currency,
            JSONB_BUILD_OBJECT(
              'currency', currency,
              'orders', orders,
              'ltv', ltv,
              'avgOrder', ROUND(avg_order, 2),
              'succeeded', succeeded,
              'failed', failed,
              'refunded', refunded,
              'lastPaymentAt', last_payment_at
            )
          ) AS metrics_by_currency,
          MAX(last_payment_at) AS last_payment_at
        FROM currency_metrics
        GROUP BY customer_id
      )
      SELECT
        c.id::text,
        c.name,
        c.email,
        c.phone,
        c.normalized_email,
        c.normalized_phone,
        c.country,
        c.ltv AS legacy_ltv,
        c.avg_order AS legacy_avg_order,
        c.orders,
        c.status,
        c.first_seen,
        c.last_seen,
        COALESCE(c.last_payment_at, m.last_payment_at) AS last_payment_at,
        c.total_succeeded,
        c.total_failed,
        c.total_refunded,
        m.metrics_by_currency
      FROM customers c
      LEFT JOIN metrics m
        ON m.customer_id = c.id
      WHERE c.merchant_id = ${merchantId}::uuid
      ORDER BY c.last_seen DESC
    `);

    return res.status(200).json({
      success: true,
      data: rows.map(row => {
        const orders = Number(row.orders ?? 0);
        const lastPaymentAt = toIso(row.last_payment_at);

        return {
          id: row.id,
          name: row.name || '',
          email: row.email || '',
          phone: row.phone || '',
          normalizedEmail: row.normalized_email || '',
          normalizedPhone: row.normalized_phone || '',
          country: row.country || '',

          // Legacy compatibility only. Currency-aware clients should use
          // metricsByCurrency instead.
          ltv: Number(row.legacy_ltv ?? 0),
          avgOrder: Number(row.legacy_avg_order ?? 0),

          orders,
          segment: segmentFor(orders, row.last_payment_at),
          status: row.status,
          firstSeen: toIso(row.first_seen),
          lastSeen: toIso(row.last_seen),
          lastPaymentAt,
          totalSucceeded: Number(row.total_succeeded ?? 0),
          totalFailed: Number(row.total_failed ?? 0),
          totalRefunded: Number(row.total_refunded ?? 0),
          metricsByCurrency: row.metrics_by_currency ?? {}
        };
      }),
      meta: {
        financialMetrics: 'currency_scoped',
        legacyLtvDeprecated: true
      }
    });
  } catch (error) {
    console.error('[COMMERCE_CUSTOMERS_V2_ERROR]', error);

    return res.status(500).json({
      success: false,
      error: {
        code: 'CUSTOMERS_ERROR',
        message: 'Erro ao carregar clientes.'
      }
    });
  }
};
