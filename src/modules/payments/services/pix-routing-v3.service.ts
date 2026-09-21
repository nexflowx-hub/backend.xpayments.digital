import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type JsonRecord = Record<string, any>;

type PolicyRow = {
  id: string;
  strategy: 'priority_failover' | 'weighted' | 'manual';
  activation_mode: 'shadow' | 'enforce';
  version: number;
  candidates: unknown;
};

type ConnectionRow = {
  connection_id: string;
  alias: string;
  provider: string;
  gateway_vault_id: string | null;
  health_status: string | null;
  observed_at: Date | string | null;
};

export interface PixRoutingV3Selection {
  mode: 'legacy' | 'shadow' | 'enforce';
  policyId: string | null;
  policyVersion: number | null;
  decisionId: string | null;
  selected: {
    connectionId: string;
    alias: string;
    provider: string;
    gatewayVaultId: string | null;
    healthStatus: 'healthy' | 'degraded' | 'unknown';
  } | null;
  reason: string;
}

const asRecord = (value: unknown): JsonRecord =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};

const healthRank = (value: string) => {
  if (value === 'healthy') return 0;
  if (value === 'unknown') return 1;
  if (value === 'degraded') return 2;
  return 3;
};

const isMissingV3Schema = (error: unknown) => {
  const value = error as { code?: string; message?: string };
  return value?.code === '42P01' || String(value?.message ?? '').includes('does not exist');
};

export const resolvePixRoutingV3 = async (input: {
  storeId: string;
  merchantId: string;
  amountMinor: number;
  environment: 'test' | 'live';
  merchantReference: string;
}): Promise<PixRoutingV3Selection> => {
  let policyRows: PolicyRow[];

  try {
    policyRows = await prisma.$queryRaw<PolicyRow[]>(Prisma.sql`
      SELECT id::text, strategy, activation_mode, version, candidates
      FROM public.routing_policies
      WHERE merchant_id = ${input.merchantId}::uuid
        AND store_id = ${input.storeId}::uuid
        AND method = 'pix'
        AND currency = 'BRL'
        AND status = 'active'
      LIMIT 1
    `);
  } catch (error) {
    if (isMissingV3Schema(error)) {
      return {
        mode: 'legacy',
        policyId: null,
        policyVersion: null,
        decisionId: null,
        selected: null,
        reason: 'routing_v3_schema_not_installed'
      };
    }
    throw error;
  }

  const policy = policyRows[0];
  if (!policy) {
    return {
      mode: 'legacy',
      policyId: null,
      policyVersion: null,
      decisionId: null,
      selected: null,
      reason: 'routing_v3_policy_missing'
    };
  }

  const configured = Array.isArray(policy.candidates)
    ? policy.candidates.map(asRecord).filter(candidate => candidate.enabled !== false)
    : [];

  if (configured.length === 0) {
    return {
      mode: policy.activation_mode,
      policyId: policy.id,
      policyVersion: policy.version,
      decisionId: null,
      selected: null,
      reason: 'no_enabled_candidates'
    };
  }

  const connectionIds = configured
    .map(candidate => String(candidate.connectionId ?? '').trim())
    .filter(Boolean);

  const rows = await prisma.$queryRaw<ConnectionRow[]>(Prisma.sql`
    SELECT
      pc.id::text AS connection_id,
      pc.alias,
      pa.provider,
      pc.gateway_vault_id::text AS gateway_vault_id,
      CASE
        WHEN health.observed_at IS NULL THEN 'unknown'
        WHEN health.observed_at < now() - interval '5 minutes' THEN 'unknown'
        ELSE health.health_status
      END AS health_status,
      health.observed_at
    FROM public.provider_connections pc
    JOIN public.provider_accounts pa ON pa.id = pc.provider_account_id
    LEFT JOIN public.gateway_vaults gv ON gv.id = pc.gateway_vault_id
    LEFT JOIN LATERAL (
      SELECT health_status, observed_at
      FROM public.provider_health_snapshots ph
      WHERE ph.provider_connection_id = pc.id
      ORDER BY observed_at DESC
      LIMIT 1
    ) health ON true
    WHERE pc.merchant_id = ${input.merchantId}::uuid
      AND pc.store_id = ${input.storeId}::uuid
      AND lower(pc.status) = 'active'
      AND lower(pa.status) = 'active'
      AND lower(pa.environment) = ${input.environment}
      AND pc.id::text = ANY(${connectionIds}::text[])
      AND (pc.gateway_vault_id IS NULL OR gv.is_active = true)
  `);

  const byId = new Map(rows.map(row => [row.connection_id, row]));
  const eligible = configured
    .map(candidate => {
      const row = byId.get(String(candidate.connectionId ?? '').trim());
      if (!row) return null;

      const minAmountMinor = Math.max(0, Number(candidate.minAmountMinor ?? 0));
      const maxAmountMinor = Math.max(minAmountMinor, Number(candidate.maxAmountMinor ?? Number.MAX_SAFE_INTEGER));
      if (input.amountMinor < minAmountMinor || input.amountMinor > maxAmountMinor) return null;

      const healthStatus = String(row.health_status ?? 'unknown').toLowerCase();
      if (healthStatus === 'unavailable') return null;

      return {
        connectionId: row.connection_id,
        alias: row.alias,
        provider: row.provider,
        gatewayVaultId: row.gateway_vault_id,
        healthStatus: (healthStatus === 'healthy' || healthStatus === 'degraded' ? healthStatus : 'unknown') as 'healthy' | 'degraded' | 'unknown',
        priority: Number(candidate.priority ?? 100),
        weight: Number(candidate.weight ?? 100)
      };
    })
    .filter(Boolean) as Array<{
      connectionId: string;
      alias: string;
      provider: string;
      gatewayVaultId: string | null;
      healthStatus: 'healthy' | 'degraded' | 'unknown';
      priority: number;
      weight: number;
    }>;

  eligible.sort((a, b) =>
    healthRank(a.healthStatus) - healthRank(b.healthStatus) ||
    a.priority - b.priority ||
    a.alias.localeCompare(b.alias)
  );

  const selected = eligible[0] ?? null;
  const idempotencyKey = `pix-route:${input.storeId}:${input.merchantReference}`.slice(0, 240);
  const snapshot = eligible.map(candidate => ({
    connectionId: candidate.connectionId,
    alias: candidate.alias,
    provider: candidate.provider,
    priority: candidate.priority,
    weight: candidate.weight,
    healthStatus: candidate.healthStatus
  }));

  const decisionRows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    INSERT INTO public.routing_decisions (
      merchant_id, store_id, method, currency, amount_minor, environment,
      strategy, activation_mode, selected_connection_id, selected_gateway_vault_id,
      eligible_connections, health_snapshot, reason, idempotency_key
    ) VALUES (
      ${input.merchantId}::uuid, ${input.storeId}::uuid, 'pix', 'BRL', ${input.amountMinor},
      ${input.environment}, ${policy.strategy}, ${policy.activation_mode},
      ${selected?.connectionId ?? null}::uuid, ${selected?.gatewayVaultId ?? null}::uuid,
      ${JSON.stringify(snapshot)}::jsonb,
      ${JSON.stringify(Object.fromEntries(snapshot.map(candidate => [candidate.connectionId, candidate.healthStatus])))}::jsonb,
      ${selected ? 'selected' : 'no_eligible_connection'}, ${idempotencyKey}
    )
    ON CONFLICT (merchant_id, idempotency_key)
    DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
    RETURNING id::text
  `);

  return {
    mode: policy.activation_mode,
    policyId: policy.id,
    policyVersion: policy.version,
    decisionId: decisionRows[0]?.id ?? null,
    selected: selected ? {
      connectionId: selected.connectionId,
      alias: selected.alias,
      provider: selected.provider,
      gatewayVaultId: selected.gatewayVaultId,
      healthStatus: selected.healthStatus
    } : null,
    reason: selected ? 'selected' : 'no_eligible_connection'
  };
};

export const attachPixRoutingDecision = async (
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
