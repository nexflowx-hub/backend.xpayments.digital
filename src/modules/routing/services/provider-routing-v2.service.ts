import { Prisma } from '@prisma/client';

import prisma from '../../../core/prisma';

type JsonRecord = Record<string, unknown>;

export type RoutingStrategy =
  | 'priority_failover'
  | 'weighted'
  | 'manual';

export type ProviderHealthStatus =
  | 'healthy'
  | 'degraded'
  | 'unavailable'
  | 'unknown';

export interface RoutingV2Request {
  merchantId: string;
  storeId: string;
  method: string;
  currency: string;
  amountMinor: number;
  environment: 'test' | 'live';
}

export interface RoutingV2Candidate {
  connectionId: string;
  alias: string;
  providerAccountId: string;
  provider: string;
  externalAccountId: string;
  gatewayVaultId: string | null;
  priority: number;
  weight: number;
  healthStatus: ProviderHealthStatus;
  healthObservedAt: string | null;
}

export interface RoutingV2Resolution {
  mode: 'legacy' | 'v2';
  strategy: RoutingStrategy | null;
  legacyProvider: string | null;
  selected: RoutingV2Candidate | null;
  eligible: RoutingV2Candidate[];
  reason: string;
  policyId?: string | null;
  policyVersion?: number | null;
}

interface ProviderConnectionRow {
  connection_id: string;
  alias: string;
  provider_account_id: string;
  provider: string;
  external_account_id: string;
  environment: string;
  default_currency: string | null;
  gateway_vault_id: string | null;
  health_status: string | null;
  health_observed_at: Date | string | null;
}

interface RoutingPolicyRow {
  id: string;
  strategy: string;
  version: number;
  candidates: unknown;
}

const asRecord = (value: unknown): JsonRecord =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};

const normalizeMethod = (value: unknown): string =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');

const normalizeCurrency = (value: unknown): string =>
  String(value ?? '')
    .trim()
    .toUpperCase();

const numberOr = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeHealth = (value: unknown): ProviderHealthStatus => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (
    normalized === 'healthy' ||
    normalized === 'degraded' ||
    normalized === 'unavailable'
  ) {
    return normalized;
  }
  return 'unknown';
};

const healthRank = (status: ProviderHealthStatus): number => {
  switch (status) {
    case 'healthy': return 0;
    case 'unknown': return 1;
    case 'degraded': return 2;
    case 'unavailable': return 3;
  }
};

export const resolveProviderRouteV2 = async (
  input: RoutingV2Request
): Promise<RoutingV2Resolution> => {
  const method = normalizeMethod(input.method);
  const currency = normalizeCurrency(input.currency);

  const store = await prisma.store.findFirst({
    where: {
      id: input.storeId,
      merchantId: input.merchantId
    },
    select: {
      routingRules: true
    }
  });

  if (!store) {
    return {
      mode: 'legacy',
      strategy: null,
      legacyProvider: null,
      selected: null,
      eligible: [],
      reason: 'store_not_found'
    };
  }

  const rules = asRecord(store.routingRules);
  const legacyProvider =
    typeof rules[method] === 'string'
      ? String(rules[method])
      : null;

  const policyRows = await prisma.$queryRaw<RoutingPolicyRow[]>(Prisma.sql`
    SELECT id::text, strategy, version, candidates
    FROM public.routing_policies
    WHERE merchant_id = ${input.merchantId}::uuid
      AND store_id = ${input.storeId}::uuid
      AND method = ${method}
      AND currency = ${currency}
      AND status = 'active'
    LIMIT 1
  `);
  const persistedPolicy = policyRows[0] ?? null;

  const methods = asRecord(rules.methods);
  const methodConfig = asRecord(methods[method]);
  const currencyConfig = asRecord(
    methodConfig[currency] ?? methodConfig.default
  );

  const routingV2Enabled =
    Boolean(persistedPolicy) || Number(rules.version) === 2;

  if (!routingV2Enabled) {
    return {
      mode: 'legacy',
      strategy: null,
      legacyProvider,
      selected: null,
      eligible: [],
      reason: 'routing_v2_not_enabled'
    };
  }

  if (!persistedPolicy && Object.keys(currencyConfig).length === 0) {
    return {
      mode: 'v2',
      strategy: null,
      legacyProvider,
      selected: null,
      eligible: [],
      reason: 'method_currency_policy_missing'
    };
  }

  const rawStrategy = String(
    persistedPolicy?.strategy ??
      currencyConfig.strategy ??
      'priority_failover'
  );

  const strategy: RoutingStrategy =
    rawStrategy === 'weighted' || rawStrategy === 'manual'
      ? rawStrategy
      : 'priority_failover';

  const candidateSource =
    persistedPolicy?.candidates ?? currencyConfig.candidates;

  const configuredCandidates = Array.isArray(candidateSource)
    ? candidateSource
        .map(asRecord)
        .filter(candidate => candidate.enabled !== false)
    : [];

  if (configuredCandidates.length === 0) {
    return {
      mode: 'v2',
      strategy,
      legacyProvider,
      selected: null,
      eligible: [],
      reason: 'no_enabled_candidates',
      policyId: persistedPolicy?.id ?? null,
      policyVersion: persistedPolicy?.version ?? null
    };
  }

  const connectionIds = configuredCandidates
    .map(candidate => String(candidate.connectionId ?? '').trim())
    .filter(Boolean);

  const aliases = configuredCandidates
    .map(candidate => String(candidate.alias ?? '').trim())
    .filter(Boolean);

  const rows = await prisma.$queryRaw<ProviderConnectionRow[]>(Prisma.sql`
    SELECT
      pc.id::text AS connection_id,
      pc.alias,
      pc.provider_account_id::text AS provider_account_id,
      pa.provider,
      pa.external_account_id,
      pa.environment,
      pa.default_currency,
      pc.gateway_vault_id::text AS gateway_vault_id,
      CASE
        WHEN health.observed_at IS NULL THEN 'unknown'
        WHEN health.observed_at < now() - interval '5 minutes' THEN 'unknown'
        ELSE health.health_status
      END AS health_status,
      CASE
        WHEN health.observed_at IS NULL THEN NULL
        WHEN health.observed_at < now() - interval '5 minutes' THEN NULL
        ELSE health.observed_at
      END AS health_observed_at
    FROM public.provider_connections pc
    JOIN public.provider_accounts pa
      ON pa.id = pc.provider_account_id
    LEFT JOIN public.gateway_vaults gv
      ON gv.id = pc.gateway_vault_id
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
      AND (
        pc.gateway_vault_id IS NULL
        OR gv.is_active = true
      )
      AND (
        pc.id::text = ANY(${connectionIds}::text[])
        OR pc.alias = ANY(${aliases}::text[])
      )
  `);

  const byConnection = new Map(
    rows.map(row => [row.connection_id, row])
  );
  const byAlias = new Map(rows.map(row => [row.alias, row]));

  const eligible: RoutingV2Candidate[] = [];

  for (const configured of configuredCandidates) {
    const connectionId = String(
      configured.connectionId ?? ''
    ).trim();
    const alias = String(configured.alias ?? '').trim();

    const row =
      (connectionId ? byConnection.get(connectionId) : undefined) ??
      (alias ? byAlias.get(alias) : undefined);

    if (!row) {
      continue;
    }

    const minAmountMinor = Math.max(
      0,
      numberOr(configured.minAmountMinor, 0)
    );
    const maxAmountMinor = Math.max(
      minAmountMinor,
      numberOr(configured.maxAmountMinor, Number.MAX_SAFE_INTEGER)
    );

    if (
      input.amountMinor < minAmountMinor ||
      input.amountMinor > maxAmountMinor
    ) {
      continue;
    }

    if (
      row.default_currency &&
      normalizeCurrency(row.default_currency) !== currency
    ) {
      continue;
    }

    const healthStatus = normalizeHealth(row.health_status);
    if (healthStatus === 'unavailable') {
      continue;
    }

    eligible.push({
      connectionId: row.connection_id,
      alias: row.alias,
      providerAccountId: row.provider_account_id,
      provider: row.provider,
      externalAccountId: row.external_account_id,
      gatewayVaultId: row.gateway_vault_id,
      priority: numberOr(configured.priority, 100),
      weight: Math.max(0, numberOr(configured.weight, 100)),
      healthStatus,
      healthObservedAt:
        row.health_observed_at instanceof Date
          ? row.health_observed_at.toISOString()
          : row.health_observed_at
            ? String(row.health_observed_at)
            : null
    });
  }

  eligible.sort((a, b) => {
    const healthDifference = healthRank(a.healthStatus) - healthRank(b.healthStatus);
    if (healthDifference !== 0) {
      return healthDifference;
    }
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    return a.alias.localeCompare(b.alias);
  });

  if (eligible.length === 0) {
    return {
      mode: 'v2',
      strategy,
      legacyProvider,
      selected: null,
      eligible,
      reason: 'no_eligible_connection',
      policyId: persistedPolicy?.id ?? null,
      policyVersion: persistedPolicy?.version ?? null
    };
  }

  /*
   * V3 persists a sticky routing decision around this deterministic selector.
   * Weighted routing remains deliberately deterministic until a weighted
   * choice can be made once and then replayed from routing_decisions.
   */
  const selected = eligible[0];

  return {
    mode: 'v2',
    strategy,
    legacyProvider,
    selected,
    eligible,
    reason:
      strategy === 'weighted'
        ? 'weighted_preview_priority_selected'
        : selected.healthStatus === 'degraded'
          ? 'selected_degraded_fallback'
          : 'selected',
    policyId: persistedPolicy?.id ?? null,
    policyVersion: persistedPolicy?.version ?? null
  };
};
