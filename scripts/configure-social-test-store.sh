#!/usr/bin/env bash
set -Eeuo pipefail

APP=/root/xpayments-backend-v3
CONTAINER=xpayments-api-v3
STORE_ID=3162ff6b-bca9-4ebd-b5f2-af1bd5281d1f
STORE_CODE=XPAYMENTS-TEST
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ENV_FILE="/root/xpayments-social-test-store-${STAMP}.env"
REPORT="/root/xpayments-social-test-store-${STAMP}.txt"

exec > >(tee -a "$REPORT") 2>&1
cd "$APP"

echo "======================================================"
echo " XPAYMENTS — SOCIAL PROJECT TEST STORE"
echo "======================================================"

echo
echo "=== 0. HEALTH ==="
curl -fsS https://api.xpayments.digital/api/health
printf '\n'

echo
echo "=== 1. CONFIGURE EXISTING STORE IDEMPOTENTLY ==="
docker exec -i \
  -e STORE_ID="$STORE_ID" \
  -e STORE_CODE="$STORE_CODE" \
  "$CONTAINER" \
  sh -lc 'cd /app && DATABASE_URL="$DIRECT_URL" NODE_PATH=/app/node_modules node' <<'NODE'
const fs = require('fs');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

function objectValue(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {}
  }
  return {};
}

(async () => {
  const store = await prisma.store.findUnique({
    where: { id: process.env.STORE_ID },
    include: { merchant: true, gatewayVaults: true, apiKeys: true }
  });

  if (!store) throw new Error('SOCIAL_TEST_STORE_NOT_FOUND');
  if (store.storeCode !== process.env.STORE_CODE) {
    throw new Error(`SOCIAL_TEST_STORE_CODE_MISMATCH:${store.storeCode}`);
  }

  console.log('STORE_FOUND=PASS');
  console.log('STORE_ID=' + store.id);
  console.log('STORE_CODE=' + store.storeCode);
  console.log('STORE_NAME=' + store.name);
  console.log('MERCHANT_NAME=' + store.merchant.name);
  console.log('MERCHANT_COMPANY=' + (store.merchant.company || 'NULL'));

  const merchantVaults = await prisma.gatewayVault.findMany({
    where: {
      merchantId: store.merchantId,
      isActive: true,
      OR: [{ storeId: store.id }, { storeId: null }]
    },
    orderBy: { createdAt: 'desc' }
  });

  const stripeVault = merchantVaults.find(v => {
    if (!String(v.provider || '').toLowerCase().startsWith('stripe')) return false;
    const credentials = objectValue(v.credentials);
    const secretKey = String(credentials.secretKey || '');
    return secretKey.startsWith('sk_test_') || secretKey.startsWith('rk_test_');
  });

  if (!stripeVault) throw new Error('SOCIAL_TEST_STRIPE_TEST_VAULT_NOT_FOUND');

  const stripeCredentials = objectValue(stripeVault.credentials);
  if (!String(stripeCredentials.webhookSecret || '').startsWith('whsec_')) {
    throw new Error('SOCIAL_TEST_STRIPE_WEBHOOK_SECRET_MISSING');
  }

  console.log('STRIPE_TEST_VAULT=PASS');
  console.log('STRIPE_PROVIDER=' + stripeVault.provider);
  console.log('STRIPE_VAULT_ID=' + stripeVault.id);

  const currentRules = objectValue(store.routingRules);
  const routingRules = {
    ...currentRules,
    card: stripeVault.provider,
    mb_way: stripeVault.provider,
    bizum: stripeVault.provider,
    multibanco: stripeVault.provider,
    stripe_all: stripeVault.provider
  };

  const existingTheme = objectValue(store.theme);
  const theme = JSON.stringify({
    ...existingTheme,
    mode: existingTheme.mode === 'dark' ? 'dark' : 'light',
    primaryColor: existingTheme.primaryColor || '#111111',
    checkoutDisplayName: existingTheme.checkoutDisplayName || store.name || 'XPayments Test',
    localeMode: existingTheme.localeMode || 'auto',
    autoReturnSeconds: Number.isFinite(Number(existingTheme.autoReturnSeconds))
      ? Number(existingTheme.autoReturnSeconds)
      : 3
  });

  await prisma.store.update({
    where: { id: store.id },
    data: {
      status: 'active',
      currency: 'EUR',
      routingRules,
      theme
    }
  });

  console.log('STORE_ACTIVE=PASS');
  console.log('STORE_ROUTING_CONFIGURED=PASS');
  console.log('STORE_BRANDING_CONFIGURED=PASS');

  let keyRecord = store.apiKeys.find(k => {
    const scopes = Array.isArray(k.scopes) ? k.scopes : [];
    return String(k.environment).toLowerCase() === 'test' && scopes.includes('payments_write');
  });

  let created = false;
  if (!keyRecord) {
    const key = `xpay_test_${crypto.randomBytes(24).toString('hex')}`;
    keyRecord = await prisma.apiKey.create({
      data: {
        storeId: store.id,
        name: 'Social Project Checkout Test',
        key,
        scopes: ['payments_write'],
        environment: 'test'
      }
    });
    created = true;
  }

  const envText = [
    `XPAY_SOCIAL_TEST_STORE_ID=${store.id}`,
    `XPAY_SOCIAL_TEST_STORE_CODE=${store.storeCode}`,
    `XPAY_SOCIAL_TEST_API_KEY=${keyRecord.key}`,
    `XPAY_SOCIAL_TEST_GATEWAY_VAULT_ID=${stripeVault.id}`,
    `XPAY_SOCIAL_TEST_PROVIDER=${stripeVault.provider}`,
    ''
  ].join('\n');

  fs.writeFileSync('/tmp/xpayments-social-test-store.env', envText, { mode: 0o600 });

  console.log('TEST_API_KEY=' + (created ? 'CREATED' : 'REUSED'));
  console.log('TEST_API_KEY_SECRET_PRINTED=NO');
})()
  .catch(err => {
    console.error('SOCIAL_TEST_STORE_ERROR=' + (err?.message || String(err)));
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
NODE

docker cp "$CONTAINER:/tmp/xpayments-social-test-store.env" "$ENV_FILE"
chmod 600 "$ENV_FILE"

echo "ENV_FILE=$ENV_FILE"
echo "ENV_FILE_MODE=$(stat -c '%a' "$ENV_FILE")"

echo
echo "=== 2. CREATE CHECKOUT SMOKE SESSION ==="
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

REFERENCE="SOCIAL-SBX-CHECKOUT-${STAMP}"
HTTP_CODE="$(curl -sS \
  -o /tmp/xpayments-social-checkout.json \
  -w '%{http_code}' \
  -X POST \
  https://api.xpayments.digital/api/v1/checkout/session \
  -H "Authorization: Bearer ${XPAY_SOCIAL_TEST_API_KEY}" \
  -H 'Content-Type: application/json' \
  --data "{\"amount\":500,\"currency\":\"EUR\",\"reference\":\"${REFERENCE}\",\"customerEmail\":\"social-checkout-test@example.com\",\"metadata\":{\"description\":\"Social Project Checkout Sandbox\",\"checkoutDisplayName\":\"XPayments Test\",\"autoReturnSeconds\":3}}")"

cat /tmp/xpayments-social-checkout.json
printf '\n'
[ "$HTTP_CODE" = "201" ]

python3 - <<'PY'
import json
x=json.load(open('/tmp/xpayments-social-checkout.json'))
data=x.get('data') or {}
assert x.get('success') is True
assert data.get('sessionId')
assert data.get('checkoutUrl')
print('SOCIAL_CHECKOUT_SESSION_CREATE=PASS')
print('SESSION_ID=' + data['sessionId'])
print('CHECKOUT_URL=' + data['checkoutUrl'])
print('EMBED_URL=' + str(data.get('embedUrl') or 'NULL'))
PY

echo
echo "=== 3. LOAD PUBLIC SESSION ==="
SESSION_ID="$(python3 - <<'PY'
import json
print(json.load(open('/tmp/xpayments-social-checkout.json'))['data']['sessionId'])
PY
)"

curl -fsS "https://api.xpayments.digital/api/v1/checkout/session/${SESSION_ID}" \
  >/tmp/xpayments-social-session-load.json
cat /tmp/xpayments-social-session-load.json
printf '\n'

python3 - <<'PY'
import json
x=json.load(open('/tmp/xpayments-social-session-load.json'))
data=x.get('data') or {}
methods={m.get('code') for m in data.get('paymentMethods', [])}
required={'card','mb_way','bizum','multibanco','stripe_all'}
assert required.issubset(methods), (required, methods)
assert data.get('status') in {'pending','processing'}
print('SOCIAL_CHECKOUT_SESSION_LOAD=PASS')
print('SOCIAL_CHECKOUT_METHODS=PASS')
PY

echo
echo "SOCIAL_PROJECT_TEST_STORE_INTEGRATION=PASS"
echo "REPORT=$REPORT"
echo "ENV_FILE=$ENV_FILE"
