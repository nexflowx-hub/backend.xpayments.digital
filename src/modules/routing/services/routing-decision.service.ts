import { Prisma } from '@prisma/client';
import prisma from '../../../core/prisma';
import {
  resolveProviderRouteV2,
  type RoutingV2Request,
  type RoutingV2Resolution
} from './provider-routing-v2.service';

type DecisionRow = {
  id: string;
  selected_connection_id: string | null;
  selected_gateway_vault_id: string | null;
  strategy: string | null;
  reason: string;
  eligible_connections: unknown;
  health_snapshot: unknown;
};

type SelectedConnectionRow = {
  connection_id: string;
  alias: string;
  provider_account_id: string;
  provider: string;
  external_account_id: string;
  gateway_vault_id: string | null;
};

export interface StickyRoutingResolution {
  decisionId: string | null;
  replayed: boolean;
  resolution: RoutingV2Resolution;
}

const safeEligibleSnapshot = (resolution: RoutingV2Resolution) =>
  resolution.eligible.map(candidate => ({
    connectionId: candidate.connectionId,
    alias: candidate.alias,
    provider: candidate.provider,
    priority: candidate.priority,
    weight: candidate.weight,
    healthStatus: candidate.healthStatus,
    healthObservedAt: candidate.healthObservedAt
  }));

export const resolveStickyProviderRoute = async (
  input: RoutingV2Request & { idempotencyKey: string }
): Promise<StickyRoutingResolution> => {
  const existing = await prisma.$queryRaw<DecisionRow[]>(Prisma.sql`
    SELECT id::text, selected_connection_id::text, selected_gateway_vault_id::text,
           strategy, reason, eligible_connections, health_snapshot
    FROM public.routing_decisions
    WHERE merchant_id = ${input.merchantId}::uuid
      AND idempotency_key = ${input.idempotencyKey}
    LIMIT 1
  `);

  const replay = existing[0];
  if (replay) {
    if (!replay.selected_connection_id) {
      const resolution = await resolveProviderRouteV2(input);
      return {
        decisionId: replay.id,
        replayed: true,
        resolution: {
          ...resolution,
          selected: null,
          eligible: [],
          reason: replay.reason
        }
      };
    }

    const selectedRows = await prisma.$queryRaw<SelectedConnectionRow[]>(Prisma.sql`
      SELECT
        pc.id::text AS connection_id,
        pc.alias,
        pc.provider_account_id::text AS provider_account_id,
        pa.provider,
        pa.external_account_id,
        pc.gateway_vault_id::text AS gateway_vault_id
      FROM public.provider_connections pc
      JOIN public.provider_accounts pa ON pa.id = pc.provider_account_id
      WHERE pc.id = ${replay.selected_connection_id}::uuid
        AND pc.merchant_id = ${input.merchantId}::uuid
        AND pc.store_id = ${input.storeId}::uuid
      LIMIT 1
    `);
    const selected = selectedRows[0];

    if (!selected) {
      return {
        decisionId: replay.id,
        replayed: true,
        resolution: {
          mode: 'v2',
          strategy: replay.strategy === 'weighted' || replay.strategy === 'manual'
            ? replay.strategy
            : 'priority_failover',
          legacyProvider: null,
          selected: null,
          eligible: [],
          reason: 'sticky_connection_missing'
        }
      };
    }

    return {
      decisionId: replay.id,
      replayed: true,
      resolution: {
        mode: 'v2',
        strategy: replay.strategy === 'weighted' || replay.strategy === 'manual'
          ? replay.strategy
          : 'priority_failover',
        legacyProvider: null,
        selected: {
          connectionId: selected.connection_id,
          alias: selected.alias,
          providerAccountId: selected.provider_account_id,
          provider: selected.provider,
          externalAccountId: selected.external_account_id,
          gatewayVaultId: selected.gateway_vault_id,
          priority: 0,
          weight: 0,
          healthStatus: 'unknown',
          healthObservedAt: null
        },
        eligible: [],
        reason: `sticky_replay:${replay.reason}`
      }
    };
  }

  const resolution = await resolveProviderRouteV2(input);
  if (resolution.mode === 'legacy') {
    return { decisionId: null, replayed: false, resolution };
  }

  const eligible = safeEligibleSnapshot(resolution);
  const healthSnapshot = Object.fromEntries(
    eligible.map(candidate => [candidate.connectionId, {
      status: candidate.healthStatus,
      observedAt: candidate.healthObservedAt
    }])
  );

  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    INSERT INTO public.routing_decisions (
      merchant_id, store_id, method, currency, amount_minor, environment,
      strategy, selected_connection_id, selected_gateway_vault_id,
      eligible_connections, health_snapshot, reason, idempotency_key
    ) VALUES (
      ${input.merchantId}::uuid,
      ${input.storeId}::uuid,
      ${input.method.toLowerCase().replace(/-/g, '_')},
      ${input.currency.toUpperCase()},
      ${input.amountMinor},
      ${input.environment},
      ${resolution.strategy},
      ${resolution.selected?.connectionId ?? null}::uuid,
      ${resolution.selected?.gatewayVaultId ?? null}::uuid,
      ${JSON.stringify(eligible)}::jsonb,
      ${JSON.stringify(healthSnapshot)}::jsonb,
      ${resolution.reason},
      ${input.idempotencyKey}
    )
    ON CONFLICT (merchant_id, idempotency_key)
    DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
    RETURNING id::text
  `);

  return {
    decisionId: rows[0]?.id ?? null,
    replayed: false,
    resolution
  };
};

export const attachRoutingDecisionToTransaction = async (
  decisionId: string | null,
  transactionId: string | null | undefined
) => {
  if (!decisionId || !transactionId) return;
  await prisma.$executeRaw(Prisma.sql`
    UPDATE public.routing_decisions
    SET transaction_id = COALESCE(transaction_id, ${transactionId}::uuid)
    WHERE id = ${decisionId}::uuid
  `);
};
