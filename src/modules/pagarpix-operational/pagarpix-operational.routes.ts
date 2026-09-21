import { Prisma } from '@prisma/client';
import { Router, Response } from 'express';

import prisma from '../../core/prisma';
import { AuthRequest } from '../../middleware/auth.middleware';
import {
  getPayoutFundingOptions,
  listPayoutRequests
} from '../payout-requests/controllers/payout-requests.controller';
import { payoutRequestsFeatureMiddleware } from '../payout-requests/middleware/payout-requests-feature.middleware';

const router = Router();
const payoutRouter = Router();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const merchantIdOf = (req: AuthRequest) => req.merchantId || req.user?.id || null;

const requireMerchant = (req: AuthRequest, res: Response): string | null => {
  const merchantId = merchantIdOf(req);
  if (!merchantId) {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Merchant não autenticado.' } });
    return null;
  }
  return merchantId;
};

const storeIdOf = (req: AuthRequest, res: Response): string | null | undefined => {
  const raw = typeof req.query.storeId === 'string' ? req.query.storeId.trim() : undefined;
  if (!raw) return undefined;
  if (!uuidPattern.test(raw)) {
    res.status(400).json({ success: false, error: { code: 'INVALID_STORE', message: 'Store inválida.' } });
    return null;
  }
  return raw;
};

payoutRouter.use(payoutRequestsFeatureMiddleware);
payoutRouter.get('/funding-options', getPayoutFundingOptions);
payoutRouter.get('/', listPayoutRequests);
router.use('/payout-requests', payoutRouter);

router.get('/routing/connections', async (req: AuthRequest, res: Response) => {
  try {
    const merchantId = requireMerchant(req, res);
    if (!merchantId) return;
    const storeId = storeIdOf(req, res);
    if (storeId === null) return;

    const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT
        pc.id::text AS id,
        pc.store_id::text AS "storeId",
        pc.alias,
        pa.provider,
        pa.environment,
        pa.default_currency AS "defaultCurrency",
        pc.mode,
        pc.status,
        pc.shadow_mode AS "shadowMode",
        pc.ledger_enabled AS "ledgerEnabled",
        health.health_status AS "healthStatus",
        health.latency_ms AS "latencyMs",
        health.success_rate AS "successRate",
        health.observed_at AS "observedAt"
      FROM public.provider_connections pc
      JOIN public.provider_accounts pa ON pa.id = pc.provider_account_id
      JOIN public.stores store_record ON store_record.id = pc.store_id
      LEFT JOIN LATERAL (
        SELECT health_status, latency_ms, success_rate, observed_at
        FROM public.provider_health_snapshots ph
        WHERE ph.provider_connection_id = pc.id
        ORDER BY observed_at DESC
        LIMIT 1
      ) health ON true
      WHERE pc.merchant_id = ${merchantId}::uuid
        AND upper(store_record.currency) = 'BRL'
        AND (${storeId ?? null}::uuid IS NULL OR pc.store_id = ${storeId ?? null}::uuid)
      ORDER BY pc.store_id, pc.alias
    `);

    return res.status(200).json({
      success: true,
      data: rows.map(row => ({
        id: row.id,
        storeId: row.storeId,
        alias: row.alias,
        provider: row.provider,
        environment: row.environment,
        defaultCurrency: row.defaultCurrency,
        mode: row.mode,
        status: row.status,
        shadowMode: row.shadowMode,
        ledgerEnabled: row.ledgerEnabled,
        health: {
          status: row.healthStatus ?? 'unknown',
          latencyMs: row.latencyMs,
          successRate: row.successRate === null || row.successRate === undefined ? null : Number(row.successRate),
          observedAt: row.observedAt ?? null
        }
      }))
    });
  } catch (error) {
    console.error('[PAGARPIX_ROUTING_CONNECTIONS_ERROR]', error);
    return res.status(500).json({ success: false, error: { code: 'ROUTING_READ_ERROR', message: 'Falha ao consultar conexões de routing.' } });
  }
});

router.get('/routing/policies', async (req: AuthRequest, res: Response) => {
  try {
    const merchantId = requireMerchant(req, res);
    if (!merchantId) return;
    const storeId = storeIdOf(req, res);
    if (storeId === null) return;

    const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT
        id::text,
        store_id::text AS "storeId",
        method,
        currency,
        strategy,
        activation_mode AS "activationMode",
        status,
        version,
        candidates,
        metadata,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM public.routing_policies
      WHERE merchant_id = ${merchantId}::uuid
        AND upper(currency) = 'BRL'
        AND (${storeId ?? null}::uuid IS NULL OR store_id = ${storeId ?? null}::uuid)
      ORDER BY store_id, method, currency
    `);

    return res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error('[PAGARPIX_ROUTING_POLICIES_ERROR]', error);
    return res.status(500).json({ success: false, error: { code: 'ROUTING_READ_ERROR', message: 'Falha ao consultar políticas de routing.' } });
  }
});

router.get('/routing/decisions', async (req: AuthRequest, res: Response) => {
  try {
    const merchantId = requireMerchant(req, res);
    if (!merchantId) return;
    const storeId = storeIdOf(req, res);
    if (storeId === null) return;
    const requestedLimit = Number(req.query.limit ?? 50);
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 100) : 50;

    const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT
        rd.id::text,
        rd.store_id::text AS "storeId",
        rd.transaction_id::text AS "transactionId",
        rd.method,
        rd.currency,
        rd.amount_minor AS "amountMinor",
        rd.environment,
        rd.strategy,
        rd.activation_mode AS "activationMode",
        rd.selected_connection_id::text AS "selectedConnectionId",
        pc.alias AS "selectedAlias",
        pa.provider AS "selectedProvider",
        rd.reason,
        rd.eligible_connections AS "eligibleConnections",
        rd.health_snapshot AS "healthSnapshot",
        rd.created_at AS "createdAt"
      FROM public.routing_decisions rd
      LEFT JOIN public.provider_connections pc ON pc.id = rd.selected_connection_id
      LEFT JOIN public.provider_accounts pa ON pa.id = pc.provider_account_id
      WHERE rd.merchant_id = ${merchantId}::uuid
        AND upper(rd.currency) = 'BRL'
        AND (${storeId ?? null}::uuid IS NULL OR rd.store_id = ${storeId ?? null}::uuid)
      ORDER BY rd.created_at DESC
      LIMIT ${limit}
    `);

    return res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error('[PAGARPIX_ROUTING_DECISIONS_ERROR]', error);
    return res.status(500).json({ success: false, error: { code: 'ROUTING_READ_ERROR', message: 'Falha ao consultar decisões de routing.' } });
  }
});

export default router;
