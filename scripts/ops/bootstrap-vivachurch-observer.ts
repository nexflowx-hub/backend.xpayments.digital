/**
 * Run ONCE in the controlled production environment AFTER the observer migration:
 *   VIVACHURCH_MERCHANT_INITIAL_PASSWORD=(read from secret manager) npx tsx scripts/ops/bootstrap-vivachurch-observer.ts
 *
 * Do not supply passwords, Stripe keys or webhook secrets on the command line.
 * Idempotent; does not reset an existing merchant password. Creates no payment.
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const db = new PrismaClient();
const merchantEmail = 'VivaChurch@XPayments.Digital';
const setup = [
  { code: 'vivachurch', storeCode: 'VIVACHURCH-GBP', name: 'VivaChurch',
    accountEnv: 'STRIPE_OBSERVER_VIVACHURCH_ACCOUNT_ID',
    secretEnv: 'STRIPE_OBSERVER_VIVACHURCH_WEBHOOK_SECRET' },
  { code: 'humanimpact', storeCode: 'HUMANIMPACT-GBP', name: 'HumanImpact',
    accountEnv: 'STRIPE_OBSERVER_HUMANIMPACT_ACCOUNT_ID',
    secretEnv: 'STRIPE_OBSERVER_HUMANIMPACT_WEBHOOK_SECRET' }
] as const;

async function main() {
  await db.$transaction(async tx => {
    let merchant = await tx.merchant.findUnique({ where: { email: merchantEmail } });
    if (!merchant) {
      const password = process.env.VIVACHURCH_MERCHANT_INITIAL_PASSWORD;
      if (!password || password.length < 12) {
        throw new Error('Missing strong merchant password in secret manager environment.');
      }
      merchant = await tx.merchant.create({
        data: {
          name: 'VivaChurch', email: merchantEmail,
          company: 'VivaChurch', status: 'active',
          passwordHash: await bcrypt.hash(password, 12)
        }
      });
    }

    for (const currency of ['GBP', 'EUR']) {
      await tx.wallet.upsert({
        where: { merchantId_currency: { merchantId: merchant.id, currency } },
        update: {},
        create: {
          merchantId: merchant.id, currency,
          label: currency === 'GBP' ? 'Principal GBP (Observer - saldo não contabilizado)' : 'EUR (Observer - saldo não contabilizado)',
          type: 'fiat'
        }
      });
    }

    for (const item of setup) {
      let store = await tx.store.findUnique({ where: { storeCode: item.storeCode } });
      if (store && store.merchantId !== merchant.id) {
        throw new Error('Store code already belongs to another merchant: ' + item.storeCode);
      }
      if (!store) {
        store = await tx.store.create({
          data: {
            merchantId: merchant.id, storeCode: item.storeCode,
            name: item.name, currency: 'GBP', status: 'observer',
            routingRules: { _config: { mode: 'observer', supportedCurrencies: ['GBP', 'EUR'] } }
          }
        });
      }

      const existing = await tx.observerSource.findUnique({ where: { sourceCode: item.code } });
      if (existing && (existing.merchantId !== merchant.id || existing.storeId !== store.id)) {
        throw new Error('Observer source belongs to another merchant or store: ' + item.code);
      }
      if (!existing) {
        await tx.observerSource.create({
          data: {
            merchantId: merchant.id, storeId: store.id,
            sourceCode: item.code, provider: 'stripe', mode: 'observer',
            accountId: process.env[item.accountEnv] || null,
            status: 'pending'
          }
        });
      }

      // Never put live Stripe keys or whsec signing secrets in GatewayVault JSON.
      // Inactive references make this a catalog record, NOT a routing gateway.
      const vault = await tx.gatewayVault.findFirst({
        where: { merchantId: merchant.id, storeId: store.id, provider: 'stripe-observer' }
      });
      if (!vault) {
        await tx.gatewayVault.create({
          data: {
            merchantId: merchant.id, storeId: store.id,
            provider: 'stripe-observer', isActive: false,
            credentials: {
              mode: 'observer',
              sourceCode: item.code,
              accountIdEnv: item.accountEnv,
              webhookSigningSecretEnv: item.secretEnv,
              permissions: ['events.read'],
              checkoutRouting: false
            }
          }
        });
      }
    }
  });
  console.log('Observer bootstrap complete: VivaChurch merchant, GBP/EUR wallets, two stores and two inactive vault references.');
  console.log('No payment, refund, payout or ledger balance was created.');
}

main().catch(e => {
  console.error('Observer bootstrap failed:', e instanceof Error ? e.message : 'unknown');
  process.exitCode = 1;
}).finally(() => db.$disconnect());
