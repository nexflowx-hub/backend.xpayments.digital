import 'dotenv/config';
import prisma from '../../src/core/prisma';
import {
  recordProviderHealthSnapshot,
  type ProviderHealthStatus
} from '../../src/modules/routing/services/provider-health.service';

const providerConnectionId = String(process.argv[2] ?? '').trim();
const healthStatus = String(process.argv[3] ?? '').trim() as ProviderHealthStatus;
const latencyRaw = process.argv[4];
const successRateRaw = process.argv[5];

const allowed = new Set(['healthy', 'degraded', 'unavailable', 'unknown']);

async function main() {
  if (!/^[0-9a-f-]{36}$/i.test(providerConnectionId) || !allowed.has(healthStatus)) {
    throw new Error(
      'Usage: npx tsx scripts/ops/record-provider-health.ts <provider-connection-uuid> <healthy|degraded|unavailable|unknown> [latency-ms] [success-rate]'
    );
  }

  const latencyMs = latencyRaw === undefined ? null : Number(latencyRaw);
  const successRate = successRateRaw === undefined ? null : Number(successRateRaw);

  if (latencyMs !== null && (!Number.isFinite(latencyMs) || latencyMs < 0)) {
    throw new Error('latency-ms must be a non-negative number.');
  }
  if (successRate !== null && (!Number.isFinite(successRate) || successRate < 0 || successRate > 100)) {
    throw new Error('success-rate must be between 0 and 100.');
  }

  const result = await recordProviderHealthSnapshot({
    providerConnectionId,
    healthStatus,
    latencyMs,
    successRate,
    source: String(process.env.PROVIDER_HEALTH_SOURCE ?? 'ops-cli'),
    metadata: { recordedBy: String(process.env.XPAYMENTS_OPS_ACTOR ?? 'ops-cli') }
  });

  console.log(JSON.stringify({ success: true, data: result }, null, 2));
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
