import 'dotenv/config';
import prisma from '../../src/core/prisma';
import {
  transitionWalletOperation,
  WalletOperationError,
  type WalletOperationStatus
} from '../../src/modules/wallet/services/wallet-operations.service';

const operationId = String(process.argv[2] ?? '').trim();
const status = String(process.argv[3] ?? '').trim() as WalletOperationStatus;
const actorId = String(process.env.XPAYMENTS_OPS_ACTOR ?? 'ops-cli').trim();
const externalReference = String(process.env.EXTERNAL_REFERENCE ?? '').trim() || null;
const failureReason = String(process.env.FAILURE_REASON ?? '').trim() || null;

const allowed = new Set(['processing', 'completed', 'failed', 'cancelled']);

async function main() {
  if (!/^[0-9a-f-]{36}$/i.test(operationId) || !allowed.has(status)) {
    throw new Error(
      'Usage: npx tsx scripts/ops/transition-wallet-operation.ts <operation-uuid> <processing|completed|failed|cancelled>'
    );
  }

  const result = await transitionWalletOperation({
    operationId,
    targetStatus: status as 'processing' | 'completed' | 'failed' | 'cancelled',
    actorType: 'admin',
    actorId,
    externalReference,
    failureReason,
    metadata: { source: 'ops-cli' }
  });

  console.log(JSON.stringify({ success: true, data: result }, null, 2));
}

main()
  .catch(error => {
    if (error instanceof WalletOperationError) {
      console.error(JSON.stringify({
        success: false,
        error: { code: error.code, message: error.message }
      }, null, 2));
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
