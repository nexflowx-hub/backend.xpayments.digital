#!/usr/bin/env bash

set -u

CONTAINER="xpayments-api-v3"
STORE_CODE="RDEURO-XPAY-SANDBOX"
PROVIDER="stripe-rdeuro-xpay-sandbox"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
REFERENCE="RDEURO-S2S-RUNTIME-CERT-${STAMP}"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

printf '\n======================================================\n'
printf ' XPAYMENTS — RDEURO S2S RUNTIME CERTIFICATION\n'
printf '======================================================\n'

printf '\n=== 0. HEALTH ===\n'
if ! curl -fsS https://api.xpayments.digital/api/health; then
  printf '\nPRE_HEALTH=FAIL\n'
  exit 1
fi
printf '\nPRE_HEALTH=PASS\n'

printf '\n=== 1. RUNTIME VERIFIER MARKER ===\n'
if docker exec "$CONTAINER" grep -q \
  'STRIPE WEBHOOK SHARED VAULT RESOLVED' \
  /app/dist/modules/payments/services/stripe-webhook-verification.service.js; then
  printf 'RUNTIME_SHARED_VAULT_MARKER=PASS\n'
else
  printf 'RUNTIME_SHARED_VAULT_MARKER=FAIL\n'
  exit 1
fi

printf '\n=== 2. ONE TEST S2S CHARGE ===\n'
printf 'REFERENCE=%s\n' "$REFERENCE"

S2S_RC=0

docker exec -i \
  -e CERT_REFERENCE="$REFERENCE" \
  -e CERT_STORE_CODE="$STORE_CODE" \
  -e CERT_PROVIDER="$PROVIDER" \
  "$CONTAINER" \
  sh -lc 'cd /app && DATABASE_URL="$DIRECT_URL" NODE_PATH=/app/node_modules node' <<'NODE' || S2S_RC=$?
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const store = await prisma.store.findUnique({
    where: { storeCode: process.env.CERT_STORE_CODE },
    include: { apiKeys: true, gatewayVaults: true }
  });

  if (!store || store.status !== 'active') {
    throw new Error('RDEURO_STORE_NOT_ACTIVE');
  }

  const key = store.apiKeys.find(k =>
    String(k.environment).toLowerCase() === 'test' &&
    Array.isArray(k.scopes) &&
    k.scopes.includes('payments_write')
  );

  if (!key) throw new Error('RDEURO_TEST_API_KEY_NOT_FOUND');

  const vault = store.gatewayVaults.find(v =>
    v.isActive === true &&
    v.provider === process.env.CERT_PROVIDER
  );

  if (!vault) throw new Error('RDEURO_TEST_VAULT_NOT_FOUND');

  console.log('RDEURO_BINDING=PASS');
  console.log('STORE_ID=' + store.id);
  console.log('VAULT_ID=' + vault.id);
  console.log('PROVIDER=' + vault.provider);
  console.log('API_KEY_SECRET_PRINTED=NO');

  const payload = {
    amount: 500,
    currency: 'EUR',
    payment_method_types: ['mb_way'],
    reference: process.env.CERT_REFERENCE,
    customer: {
      name: 'RDEuro Runtime Certification',
      email: 'rdeuro-runtime-cert@example.com',
      phone: '+351911111117'
    },
    metadata: {
      order_id: process.env.CERT_REFERENCE,
      certification: 'shared_vault_runtime_s2s'
    }
  };

  const response = await fetch(
    'http://127.0.0.1:8084/api/v1/payments/charge',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key.key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    }
  );

  const raw = await response.text();
  console.log('S2S_HTTP=' + response.status);
  console.log('S2S_RESPONSE=' + raw);

  if (!response.ok) throw new Error('S2S_INITIATE_FAILED');

  let transaction = null;

  for (let i = 1; i <= 50; i++) {
    transaction = await prisma.transaction.findFirst({
      where: { reference: process.env.CERT_REFERENCE }
    });

    const walletCount = transaction
      ? await prisma.walletMovement.count({
          where: { transactionId: transaction.id }
        })
      : 0;

    console.log(
      `TX_POLL_${i}=${transaction?.status || 'NONE'}:wallet=${walletCount}`
    );

    if (transaction?.status === 'succeeded' && walletCount >= 1) {
      console.log('S2S_TRANSACTION_ID=' + transaction.id);
      console.log('S2S_PROVIDER_ID=' + (transaction.providerId || 'NONE'));
      console.log('S2S_FINAL_STATUS=succeeded');
      console.log('S2S_WALLET_MOVEMENT_COUNT=' + walletCount);
      console.log('S2S_RUNTIME_CERT=PASS');
      return;
    }

    if (['failed', 'canceled', 'cancelled'].includes(transaction?.status)) {
      throw new Error('S2S_TRANSACTION_FINAL_FAILURE_' + transaction.status);
    }

    await sleep(2000);
  }

  if (transaction) {
    const walletCount = await prisma.walletMovement.count({
      where: { transactionId: transaction.id }
    });
    console.log('S2S_TRANSACTION_ID=' + transaction.id);
    console.log('S2S_FINAL_STATUS=' + transaction.status);
    console.log('S2S_WALLET_MOVEMENT_COUNT=' + walletCount);
  }

  throw new Error('S2S_SETTLEMENT_TIMEOUT');
})()
.catch(error => {
  console.error('S2S_CERT_ERROR=' + (error?.stack || error?.message || String(error)));
  process.exitCode = 1;
})
.finally(() => prisma.$disconnect());
NODE

printf '\nS2S_NODE_RC=%s\n' "$S2S_RC"

printf '\n=== 3. WEBHOOK / SHARED VAULT LOGS ===\n'
docker logs \
  --since "$STARTED_AT" \
  "$CONTAINER" \
  2>&1 \
  | grep -E \
    "$REFERENCE|STRIPE WEBHOOK SHARED VAULT RESOLVED|STRIPE WEBHOOK VERIFIED|STRIPE WEBHOOK VAULT MISMATCH|STRIPE WEBHOOK REJECTED|payment_intent.succeeded|charge.updated" \
  | tail -n 220 \
  || true

printf '\n=== 4. FINAL HEALTH ===\n'
curl -sS https://api.xpayments.digital/api/health
printf '\n'

if [ "$S2S_RC" -ne 0 ]; then
  printf '\nRDEURO_S2S_RUNTIME_FINAL=FAIL\n'
  exit "$S2S_RC"
fi

printf '\nRDEURO_S2S_RUNTIME_FINAL=PASS\n'
