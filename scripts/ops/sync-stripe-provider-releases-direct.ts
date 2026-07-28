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
    'DIRECT_URL não configurada.'
  );
}

process.env.DATABASE_URL = directUrl;
process.env.XPAYMENTS_DATABASE_MODE =
  'DIRECT_URL';

console.log({
  databaseMode: 'DIRECT_URL',
  operation: 'stripe_provider_release_bulk_sync'
});

require('./sync-stripe-provider-releases');
