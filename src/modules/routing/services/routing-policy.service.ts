import { Prisma } from '@prisma/client';
import prisma from '../../../core/prisma';

type JsonRecord = Record<string, unknown>;

export type RoutingStrategy = 'priority_failover' | 'weighted' | 'manual';
export type RoutingActivationMode = 'shadow' | 'enforce';

export interface PolicyCandidateInput {
  connectionId: string;
  enabled?: boolean;
  priority?: number;
  weight?: number;
  minAmountMinor?: number;
  maxAmountMinor?: number;
}

type ProviderConnectionSafeRow = {
  id: string;
  store_id: string;
  alias: string;
  mode: string;
  status: string;
  shadow_mode: boolean;
  ledger_enabled: boolean;
  provider: string;
  environment: string;
  default_currency: string | null;
  health_status: string | null;
  latency_ms: number | null;
  success_rate: unknown;
  observed_at: Date | string | null;
};

type RoutingPolicyRow = {
  id: string;
  merchant_id: string;
  store_id: string;
  method: string;
  currency: string;
  strategy: RoutingStrategy;
  activation_mode: RoutingActivationMode;
  status: string;
  version: number;
  candidates: unknown;
  metadata: JsonRecord | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export class RoutingPolicyError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus = 400
  ) {
    super(message);
  }
}

const normalizeMethod = (value: unknown) =>
  String(value ?? '').trim().toLowerCase().replace(/-/g, '_');

const normalizeCurrency = (value: unknown) =>
  String(value ?? '').trim().toUpperCase();

const serializePolicy = (row: RoutingPolicyRow) => ({
  id: row.id,
  storeId: row.store_id,
  method: row.method,
  currency: row.currency,
  strategy: row.strategy,
  activationMode: row.activation_mode,
  status: row.status,
  version: row.version,
  candidates: Array.isArray(row.candidates) ? row.candidates : [],
  metadata: row.metadata ?? {},
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

export const listProviderConnectionsSafe = async (merchantId: string, storeId?: string) => {
  const rows = await prisma.$queryRaw<ProviderConnectionSafeRow[]>(Prisma.sql`
    SELECT
      pc.id::text,
      pc.store_id::text,
      pc.alias,
      pc.mode,
      pc.status,
      pc.shadow_mode,
      pc.ledger_enabled,
      pa.provider,
      pa.environment,
      pa.default_currency,
      health.health_status,
      health.latency_ms,
      health.success_rate,
      health.observed_at
    FROM public.provider_connections pc
    JOIN public.provider_accounts pa ON pa.id = pc.provider_account_id
    LEFT JOIN LATERAL (
      SELECT health_status, latency_ms, success_rate, observed_at
      FROM public.provider_health_snapshots ph
      WHERE ph.provider_connection_id = pc.id
      ORDER BY observed_at DESC
      LIMIT 1
    ) health ON true
    WHERE pc.merchant_id = ${merchantId}::uuid
      AND (${storeId ?? null}::uuid IS NULL OR pc.store_id = ${storeId ?? null}::uuid)
    ORDER BY pc.store_id, pc.alias
  `);

  return rows.map(row => ({
    id: row.id,
    storeId: row.store_id,
    alias: row.alias,
    provider: row.provider,
    environment: row.environment,
    defaultCurrency: row.default_currency,
    mode: row.mode,
    status: row.status,
    shadowMode: row.shadow_mode,
    ledgerEnabled: row.ledger_enabled,
    health: {
      status: row.health_status ?? 'unknown',
      latencyMs: row.latency_ms,
      successRate: row.success_rate === null ? null : Number(row.success_rate),
      observedAt: row.observed_at
    }
  }));
};

export const listRoutingPolicies = async (merchantId: string, storeId?: string) => {
  const rows = await prisma.$queryRaw<RoutingPolicyRow[]>(Prisma.sql`
    SELECT *
    FROM public.routing_policies
    WHERE merchant_id = ${merchantId}::uuid
      AND (${storeId ?? null}::uuid IS NULL OR store_id = ${storeId ?? null}::uuid)
    ORDER BY store_id, method, currency
  `);
  return rows.map(serializePolicy);
};

export const upsertRoutingPolicy = async (input: {
  merchantId: string;
  storeId: string;
  method: string;
  currency: string;
  strategy: RoutingStrategy;
  activationMode?: RoutingActivationMode;
  candidates: PolicyCandidateInput[];
  status?: 'active' | 'inactive';
}) => {
  const method = normalizeMethod(input.method);
  const currency = normalizeCurrency(input.currency);
  const activationMode = input.activationMode ?? 'shadow';
  if (!method) throw new RoutingPolicyError('INVALID_METHOD', 'Método de pagamento inválido.');
  if (!/^[A-Z0-9]{3,10}$/.test(currency)) throw new RoutingPolicyError('INVALID_CURRENCY', 'Moeda inválida.');
  if (input.candidates.length === 0) throw new RoutingPolicyError('NO_CANDIDATES', 'Informe pelo menos uma conexão de provider.');

  return prisma.$transaction(async tx => {
    const store = await tx.store.findFirst({
      where: { id: input.storeId, merchantId: input.merchantId },
      select: { id: true, routingRules: true }
    });
    if (!store) throw new RoutingPolicyError('STORE_NOT_FOUND', 'Store não encontrada.', 404);

    const ids = input.candidates.map(candidate => candidate.connectionId);
    const connectionRows = await tx.$queryRaw<Array<{ id: string; alias: string }>>(Prisma.sql`
      SELECT id::text, alias
      FROM public.provider_connections
      WHERE merchant_id = ${input.merchantId}::uuid
        AND store_id = ${input.storeId}::uuid
        AND id::text = ANY(${ids}::text[])
    `);
    if (connectionRows.length !== new Set(ids).size) {
      throw new RoutingPolicyError('INVALID_CONNECTION', 'Uma ou mais conexões não pertencem à Store.', 409);
    }

    const aliases = new Map(connectionRows.map(row => [row.id, row.alias]));
    const candidates = input.candidates.map(candidate => ({
      connectionId: candidate.connectionId,
      alias: aliases.get(candidate.connectionId),
      enabled: candidate.enabled !== false,
      priority: Math.max(0, Math.trunc(candidate.priority ?? 100)),
      weight: Math.max(0, Number(candidate.weight ?? 100)),
      minAmountMinor: Math.max(0, Math.trunc(candidate.minAmountMinor ?? 0)),
      maxAmountMinor: Math.max(
        Math.max(0, Math.trunc(candidate.minAmountMinor ?? 0)),
        Math.trunc(candidate.maxAmountMinor ?? Number.MAX_SAFE_INTEGER)
      )
    }));

    const rows = await tx.$queryRaw<RoutingPolicyRow[]>(Prisma.sql`
      INSERT INTO public.routing_policies (
        merchant_id, store_id, method, currency, strategy, activation_mode, status, candidates, metadata
      ) VALUES (
        ${input.merchantId}::uuid, ${input.storeId}::uuid, ${method}, ${currency},
        ${input.strategy}, ${activationMode}, ${input.status ?? 'active'}, ${JSON.stringify(candidates)}::jsonb,
        '{"managedBy":"routing-v3"}'::jsonb
      )
      ON CONFLICT (merchant_id, store_id, method, currency)
      DO UPDATE SET
        strategy = EXCLUDED.strategy,
        activation_mode = EXCLUDED.activation_mode,
        status = EXCLUDED.status,
        candidates = EXCLUDED.candidates,
        version = public.routing_policies.version + 1,
        updated_at = now()
      RETURNING *
    `);

    const currentRules = store.routingRules && typeof store.routingRules === 'object' && !Array.isArray(store.routingRules)
      ? (store.routingRules as JsonRecord)
      : {};
    const methods = currentRules.methods && typeof currentRules.methods === 'object' && !Array.isArray(currentRules.methods)
      ? { ...(currentRules.methods as JsonRecord) }
      : {};
    const methodRules = methods[method] && typeof methods[method] === 'object' && !Array.isArray(methods[method])
      ? { ...(methods[method] as JsonRecord) }
      : {};

    methodRules[currency] = {
      strategy: input.strategy,
      activationMode,
      candidates,
      policyId: rows[0].id,
      policyVersion: rows[0].version
    };
    methods[method] = methodRules;

    await tx.store.update({
      where: { id: input.storeId },
      data: { routingRules: { ...currentRules, version: 2, methods } as Prisma.InputJsonValue }
    });

    return serializePolicy(rows[0]);
  });
};

export const listRoutingDecisions = async (merchantId: string, storeId?: string, limit = 50) => {
  const safeLimit = Math.min(Math.max(limit, 1), 100);
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT
      rd.id,
      rd.store_id AS "storeId",
      rd.transaction_id AS "transactionId",
      rd.method,
      rd.currency,
      rd.amount_minor AS "amountMinor",
      rd.environment,
      rd.strategy,
      rd.activation_mode AS "activationMode",
      rd.selected_connection_id AS "selectedConnectionId",
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
      AND (${storeId ?? null}::uuid IS NULL OR rd.store_id = ${storeId ?? null}::uuid)
    ORDER BY rd.created_at DESC
    LIMIT ${safeLimit}
  `);
  return rows;
};
