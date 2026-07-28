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

const directUrl = String(
  process.env.DIRECT_URL || ''
).trim();

if (!directUrl) {
  throw new Error(
    'DIRECT_URL não configurada. O sincronizador operacional não será executado pelo pooler.'
  );
}

/*
 * O backfill operacional usa ligação direta para evitar
 * herdar estado de sessão do pooler (por exemplo,
 * default_transaction_read_only=on deixado por diagnósticos).
 * A aplicação e os webhooks continuam a usar a configuração
 * normal definida para o runtime.
 */
process.env.DATABASE_URL = directUrl;
process.env.STRIPE_RELEASE_SYNC_DATABASE_MODE =
  'DIRECT_URL';

console.log(
  'Stripe provider release sync: databaseMode=DIRECT_URL'
);

require('./sync-stripe-provider-releases');
