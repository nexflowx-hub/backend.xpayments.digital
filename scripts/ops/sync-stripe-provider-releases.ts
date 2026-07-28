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

const CONFIRM =
  process.env.CONFIRM === 'YES';

const SYNC_ALL =
  process.env.SYNC_ALL === 'YES';

const DELAY_MS = Math.max(
  0,
  Number(
    process.env.STRIPE_RELEASE_SYNC_DELAY_MS ||
      120
  )
);

const sleep = (milliseconds: number) =>
  new Promise(resolve =>
    setTimeout(resolve, milliseconds)
  );

const stamp = () =>
  new Date()
    .toISOString()
    .replace(/[:.]/g, '-');

async function main() {
  const prismaModule =
    require('../../src/core/prisma');

  const prisma = prismaModule.default;

  const {
    syncStripeBalanceFromWebhookEvent
  } = require(
    '../../src/modules/payments/services/stripe-balance-sync.service'
  );

  const outputRoot =
    process.env.STRIPE_RELEASE_SYNC_OUTPUT_DIR ||
    '/root/audits/xpayments-stripe-release-sync';

  const outputDir = path.join(
    outputRoot,
    stamp()
  );

  const rows = await prisma.$queryRawUnsafe(`
    SELECT DISTINCT
      transaction_record.id::text
        AS transaction_id,

      transaction_record.provider_id
        AS provider_id,

      store.store_code,
      store.name AS store_name,

      movement.provider_synced_at,
      movement.provider_available_on,
      movement.provider_balance_status

    FROM public.transactions
      AS transaction_record

    INNER JOIN public.wallet_movements
      AS movement

      ON (
        movement.transaction_id =
          transaction_record.id

        OR movement.reference =
          transaction_record.id::text
      )

    LEFT JOIN public.stores
      AS store

      ON store.id =
        transaction_record.store_id

    WHERE lower(
      transaction_record.status
    ) = 'succeeded'

      AND transaction_record.provider_id
        LIKE 'pi_%'

      AND transaction_record.gateway_vault_id
        IS NOT NULL

      AND movement.type = 'payment'
      AND movement.direction = 'in'

      ${SYNC_ALL
        ? ''
        : `AND (
            movement.provider_synced_at IS NULL
            OR movement.provider_available_on IS NULL
            OR movement.provider_balance_transaction_id IS NULL
          )`}

    ORDER BY
      store.store_code,
      transaction_record.id
  `);

  console.log(
    '============================================================'
  );
  console.log(
    'XPAYMENTS — STRIPE PROVIDER RELEASE SYNC'
  );
  console.log(
    '============================================================'
  );
  console.log({
    mode: CONFIRM
      ? 'WRITE_PROVIDER_SNAPSHOT'
      : 'READ_ONLY',
    syncAll: SYNC_ALL,
    transactions: rows.length,
    delayMs: DELAY_MS,
    outputDir
  });

  if (!CONFIRM) {
    console.log();
    console.log(
      'Nenhuma alteração foi realizada.'
    );
    console.log(
      'Para sincronizar, execute com CONFIRM=YES.'
    );
    return;
  }

  fs.mkdirSync(outputDir, {
    recursive: true,
    mode: 0o700
  });

  const results: any[] = [];

  for (
    let index = 0;
    index < rows.length;
    index += 1
  ) {
    const row = rows[index];

    try {
      const result =
        await syncStripeBalanceFromWebhookEvent({
          type:
            'payment_intent.succeeded',
          data: {
            object: {
              id: row.provider_id,
              metadata: {
                nexflowx_transaction_id:
                  row.transaction_id
              }
            }
          }
        });

      results.push({
        ...row,
        ...result
      });

      console.log(
        `[${index + 1}/${rows.length}] ` +
        `${row.store_code || 'SEM-STORE'} ` +
        `${row.provider_id}: ` +
        `${result.synced ? 'SYNCED' : result.reason}`
      );
    } catch (error: any) {
      results.push({
        ...row,
        synced: false,
        reason: 'exception',
        error: String(
          error?.message || error
        ).slice(0, 500)
      });

      console.error(
        `[${index + 1}/${rows.length}] ` +
        `${row.store_code || 'SEM-STORE'} ` +
        `${row.provider_id}: ERROR`,
        error?.message || error
      );
    }

    if (DELAY_MS > 0) {
      await sleep(DELAY_MS);
    }
  }

  const summary = {
    generatedAt:
      new Date().toISOString(),
    mode:
      'WRITE_PROVIDER_SNAPSHOT',
    syncAll: SYNC_ALL,
    total: results.length,
    synced: results.filter(
      item => item.synced
    ).length,
    notSynced: results.filter(
      item => !item.synced
    ).length,
    reasons: results.reduce(
      (
        accumulator: Record<string, number>,
        item: any
      ) => {
        const key = item.synced
          ? 'synced'
          : String(
              item.reason || 'unknown'
            );

        accumulator[key] =
          (accumulator[key] || 0) + 1;

        return accumulator;
      },
      {}
    )
  };

  fs.writeFileSync(
    path.join(outputDir, 'summary.json'),
    JSON.stringify(summary, null, 2),
    {
      mode: 0o600
    }
  );

  fs.writeFileSync(
    path.join(outputDir, 'results.json'),
    JSON.stringify(results, null, 2),
    {
      mode: 0o600
    }
  );

  console.log();
  console.log(
    JSON.stringify(summary, null, 2)
  );
  console.log();
  console.log('Relatórios:');
  console.log(
    path.join(outputDir, 'summary.json')
  );
  console.log(
    path.join(outputDir, 'results.json')
  );
}

main()
  .catch((error: any) => {
    console.error(
      'STRIPE_PROVIDER_RELEASE_SYNC_FATAL:',
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
