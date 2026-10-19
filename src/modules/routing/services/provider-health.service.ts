import { Prisma } from '@prisma/client';
import prisma from '../../../core/prisma';

export type ProviderHealthStatus =
  | 'healthy'
  | 'degraded'
  | 'unavailable'
  | 'unknown';

export const recordProviderHealthSnapshot = async (input: {
  providerConnectionId: string;
  healthStatus: ProviderHealthStatus;
  latencyMs?: number | null;
  successRate?: number | null;
  source?: string;
  metadata?: Record<string, unknown>;
}) => {
  const latencyMs = input.latencyMs === undefined || input.latencyMs === null
    ? null
    : Math.max(0, Math.trunc(input.latencyMs));
  const successRate = input.successRate === undefined || input.successRate === null
    ? null
    : Math.max(0, Math.min(100, Number(input.successRate)));

  const connectionRows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id::text
    FROM public.provider_connections
    WHERE id = ${input.providerConnectionId}::uuid
    LIMIT 1
  `);

  if (!connectionRows[0]) {
    throw new Error('PROVIDER_CONNECTION_NOT_FOUND');
  }

  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    INSERT INTO public.provider_health_snapshots (
      provider_connection_id,
      health_status,
      latency_ms,
      success_rate,
      source,
      metadata
    ) VALUES (
      ${input.providerConnectionId}::uuid,
      ${input.healthStatus},
      ${latencyMs},
      ${successRate},
      ${input.source ?? 'observer'},
      ${JSON.stringify(input.metadata ?? {})}::jsonb
    )
    RETURNING id, provider_connection_id AS "providerConnectionId",
              health_status AS "healthStatus", latency_ms AS "latencyMs",
              success_rate AS "successRate", source, observed_at AS "observedAt"
  `);

  return rows[0];
};
