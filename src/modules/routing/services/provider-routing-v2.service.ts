import { Prisma } from '@prisma/client';

import prisma from '../../../core/prisma';

type JsonRecord = Record<string, unknown>;

export type RoutingStrategy =
  | 'priority_failover'
  | 'weighted'
  | 'manual';

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
}

export interface RoutingV2Resolution {
  mode: 'legacy' | 'v2';
  strategy: RoutingStrategy | null;
  legacyProvider: string | null;
  selected: RoutingV2Candidate | null;
  eligible: RoutingV2Candidate[];
  reason: string;
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

/**
 * Routing V2 is intentionally opt-in.
 *
 * Existing stores keep their current routingRules shape and therefore stay
 * on the legacy payment path. Nothing calls this resolver from the certified
 * Direct controller yet.
 *
 * Canonical V2 shape:
 * {
 *   version: 2,
 *   methods: {
 *     pix: {
 *       BRL: {
 *         strategy: 'priority_failover',
 *         candidates: [
 *           { connectionId: '...', priority: 10, enabled: true, weight: 100 }
 *         ]
 *       }
 *     }
 *   }
 * }
 */
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

  if (Number(rules.version) !== 2) {
    return {
      mode: 'legacy',
      strategy: null,
      legacyProvider,
      selected: null,
      eligible: [],
      reason: 'routing_v2_not_enabled'
    };
  }

  const methods = asRecord(rules.methods);
  const methodConfig = asRecord(methods[method]);
  const currencyConfig = asRecord(
    methodConfig[currency] ?? methodConfig.default
  );

  if (Object.keys(currencyConfig).length === 0) {
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
    currencyConfig.strategy ?? 'priority_failover'
  );

  const strategy: RoutingStrategy =
    rawStrategy === 'weighted' || rawStrategy === 'manual'
      ? rawStrategy
      : 'priority_failover';

  const configuredCandidates = Array.isArray(currencyConfig.candidates)
    ? currencyConfig.candidates
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
      reason: 'no_enabled_candidates'
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
      pc.gateway_vault_id::text AS gateway_vault_id
    FROM provider_connections pc
    JOIN provider_accounts pa
      ON pa.id = pc.provider_account_id
    LEFT JOIN gateway_vaults gv
      ON gv.id = pc.gateway_vault_id
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

    eligible.push({
      connectionId: row.connection_id,
      alias: row.alias,
      providerAccountId: row.provider_account_id,
      provider: row.provider,
      externalAccountId: row.external_account_id,
      gatewayVaultId: row.gateway_vault_id,
      priority: numberOr(configured.priority, 100),
      weight: Math.max(0, numberOr(configured.weight, 100))
    });
  }

  eligible.sort((a, b) => {
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
      reason: 'no_eligible_connection'
    };
  }

  // Only deterministic priority selection is activated in V1 of the resolver.
  // Weighted routing is intentionally deferred until sticky/idempotent selection
  // and provider health are persisted as first-class routing decisions.
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
        : 'selected'
  };
};
