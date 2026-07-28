/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

for (const envFile of [
  '/root/xpayments-backend-v3/.env',
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '.env.production')
]) {
  if (fs.existsSync(envFile)) {
    dotenv.config({
      path: envFile,
      override: false,
      quiet: true
    });
  }
}

const transactionId = String(
  process.env.STRIPE_RELEASE_SYNC_TRANSACTION_ID || ''
).trim();

const confirmed =
  process.env.CONFIRM === 'YES';

const directUrl = String(
  process.env.DIRECT_URL || ''
).trim();

if (!/^[0-9a-f-]{36}$/i.test(transactionId)) {
  throw new Error(
    'STRIPE_RELEASE_SYNC_TRANSACTION_ID inválido.'
  );
}

if (!directUrl) {
  throw new Error(
    'DIRECT_URL não configurada.'
  );
}

process.env.DATABASE_URL = directUrl;

async function main() {
  const prismaModule =
    require('../../src/core/prisma');

  const prisma = prismaModule.default;

  const transaction =
    await prisma.transaction.findUnique({
      where: {
        id: transactionId
      },
      include: {
        store: true,
        gatewayVault: true
      }
    });

  if (!transaction) {
    throw new Error(
      `Transação não encontrada: ${transactionId}`
    );
  }

  const candidate = {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    status: transaction.status,
    amount: Number(transaction.amount),
    platformFee: Number(transaction.fee),
    storeCode: transaction.store?.storeCode || null,
    storeName: transaction.store?.name || null,
    gatewayVaultId: transaction.gatewayVaultId,
    databaseMode: 'DIRECT_URL'
  };

  console.log(
    JSON.stringify(candidate, null, 2)
  );

  if (!confirmed) {
    console.log(
      'READ_ONLY: nenhuma alteração foi realizada.'
    );
    return;
  }

  if (
    String(transaction.status).toLowerCase() !==
      'succeeded' ||
    !String(transaction.providerId || '').startsWith(
      'pi_'
    ) ||
    !transaction.gatewayVaultId
  ) {
    throw new Error(
      'A transação não é elegível para sincronização Stripe.'
    );
  }

  const {
    syncStripeBalanceFromWebhookEvent
  } = require(
    '../../src/modules/payments/services/stripe-balance-sync.service'
  );

  const result =
    await syncStripeBalanceFromWebhookEvent({
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: transaction.providerId,
          metadata: {
            nexflowx_transaction_id:
              transaction.id
          }
        }
      }
    });

  console.log(
    JSON.stringify(result, null, 2)
  );

  if (!result.synced) {
    throw new Error(
      `Sincronização não concluída: ${result.reason || 'unknown'}`
    );
  }
}

main()
  .catch((error: any) => {
    console.error(
      'STRIPE_PROVIDER_RELEASE_ONE_FATAL:',
      error?.message || error
    );

    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      const prismaModule =
        require('../../src/core/prisma');

      await prismaModule.default.$disconnect();
    } catch {
      // Nada a desligar.
    }
  });
