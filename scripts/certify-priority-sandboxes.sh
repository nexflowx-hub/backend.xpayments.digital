#!/usr/bin/env bash
set -Eeuo pipefail

CONTAINER="xpayments-api-v3"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
REPORT="/root/xpayments-priority-sandboxes-${STAMP}.txt"
TEST_PHONE="+351911111117"

exec > >(tee -a "$REPORT") 2>&1

echo "======================================================"
echo " XPAYMENTS — PRIORITY SANDBOX CERTIFICATION"
echo "======================================================"

echo
echo "=== 0. HEALTH ==="
curl -fsS https://api.xpayments.digital/api/health >/tmp/xp-priority-health.json
cat /tmp/xp-priority-health.json
printf '\n'
python3 - <<'PY'
import json
x=json.load(open('/tmp/xp-priority-health.json'))
assert x.get('status') == 'ONLINE', x
assert x.get('engine') == 'XPayments', x
print('PRE_HEALTH=PASS')
PY

certify_store() {
  local STORE_CODE="$1"
  local EXPECTED_STORE_ID="$2"
  local EXPECTED_PROVIDER="$3"
  local LABEL="$4"
  local SLUG="$5"
  local REF="${SLUG}-SBX-MBWAY-${STAMP}"

  echo
  echo "======================================================"
  echo " CERTIFY ${STORE_CODE}"
  echo "======================================================"

  local BINDING
  BINDING="$(docker exec \
    -e STORE_CODE="$STORE_CODE" \
    -e EXPECTED_STORE_ID="$EXPECTED_STORE_ID" \
    -e EXPECTED_PROVIDER="$EXPECTED_PROVIDER" \
    "$CONTAINER" \
    sh -lc 'cd /app && DATABASE_URL="$DIRECT_URL" NODE_PATH=/app/node_modules node' <<'NODE'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const store = await prisma.store.findUnique({
    where: { storeCode: process.env.STORE_CODE },
    include: { apiKeys: true, gatewayVaults: true, merchant: true }
  });
  if (!store) throw new Error('STORE_NOT_FOUND');
  if (store.id !== process.env.EXPECTED_STORE_ID) throw new Error(`STORE_ID_MISMATCH:${store.id}`);
  if (store.status !== 'active') throw new Error(`STORE_NOT_ACTIVE:${store.status}`);

  const key = store.apiKeys.find(k => {
    const scopes = Array.isArray(k.scopes) ? k.scopes : [];
    return String(k.environment || '').toLowerCase() === 'test' && scopes.includes('payments_write');
  });
  if (!key) throw new Error('TEST_PAYMENTS_WRITE_KEY_NOT_FOUND');

  const vault = store.gatewayVaults.find(v =>
    v.isActive === true &&
    String(v.provider || '').toLowerCase() === process.env.EXPECTED_PROVIDER.toLowerCase()
  );
  if (!vault) throw new Error('EXPECTED_ACTIVE_VAULT_NOT_FOUND');

  let c = vault.credentials || {};
  if (typeof c === 'string') {
    try { c = JSON.parse(c); } catch { c = {}; }
  }
  const sk = String(c.secretKey || '');
  const wh = String(c.webhookSecret || '');
  if (!(sk.startsWith('sk_test_') || sk.startsWith('rk_test_'))) throw new Error('VAULT_NOT_TEST_MODE');
  if (!wh.startsWith('whsec_')) throw new Error('WEBHOOK_SECRET_MISSING');

  process.stdout.write([
    key.key,
    store.id,
    store.merchantId,
    vault.id,
    vault.provider,
    store.name
  ].join('|'));
})()
.catch(err => {
  console.error('BINDING_ERROR=' + (err?.message || String(err)));
  process.exitCode = 1;
})
.finally(() => prisma.$disconnect());
NODE
  )"

  IFS='|' read -r API_KEY STORE_ID MERCHANT_ID VAULT_ID PROVIDER STORE_NAME <<<"$BINDING"
  [ -n "$API_KEY" ]
  [ "$STORE_ID" = "$EXPECTED_STORE_ID" ]
  [ "$PROVIDER" = "$EXPECTED_PROVIDER" ]

  echo "STORE_BINDING=PASS"
  echo "STORE_ID=$STORE_ID"
  echo "STORE_NAME=$STORE_NAME"
  echo "PROVIDER=$PROVIDER"
  echo "API_KEY_SECRET_PRINTED=NO"
  echo "REFERENCE=$REF"

  local CREATE_HTTP
  CREATE_HTTP="$(curl -sS \
    -o "/tmp/xp-${SLUG}-create.json" \
    -w '%{http_code}' \
    -X POST https://api.xpayments.digital/api/v1/checkout/session \
    -H "Authorization: Bearer ${API_KEY}" \
    -H 'Content-Type: application/json' \
    -d "{
      \"amount\":500,
      \"currency\":\"EUR\",
      \"reference\":\"${REF}\",
      \"customerEmail\":\"${SLUG}-sandbox@example.com\",
      \"returnUrl\":\"https://example.com/payment-complete\",
      \"metadata\":{
        \"customerName\":\"${LABEL} Sandbox\",
        \"description\":\"XPayments ${LABEL} Sandbox Certification\"
      }
    }")"

  [ "$CREATE_HTTP" = "201" ] || {
    echo "SESSION_CREATE_HTTP=$CREATE_HTTP"
    cat "/tmp/xp-${SLUG}-create.json"
    exit 1
  }

  local SESSION_ID
  SESSION_ID="$(python3 - "$SLUG" "$EXPECTED_STORE_ID" <<'PY'
import json,sys
slug=sys.argv[1]
expected=sys.argv[2]
x=json.load(open(f'/tmp/xp-{slug}-create.json'))
assert x.get('success') is True, x
d=x.get('data') or {}
assert d.get('sessionId') and d.get('checkoutUrl') and d.get('embedUrl'), d
print(d['sessionId'])
PY
  )"

  echo "CHECKOUT_SESSION_CREATE=PASS"
  echo "SESSION_ID=$SESSION_ID"
  echo "CHECKOUT_URL=https://checkout.xpayments.digital/pay/${SESSION_ID}"
  echo "EMBED_URL=https://checkout.xpayments.digital/embed/${SESSION_ID}"

  curl -fsS \
    "https://api.xpayments.digital/api/v1/checkout/session/${SESSION_ID}" \
    >"/tmp/xp-${SLUG}-load.json"

  python3 - "$SLUG" "$EXPECTED_STORE_ID" <<'PY'
import json,sys
slug=sys.argv[1]
expected_store=sys.argv[2]
x=json.load(open(f'/tmp/xp-{slug}-load.json'))
assert x.get('success') is True, x
d=x.get('data') or {}
assert d.get('storeId') == expected_store, d
assert d.get('status') == 'pending', d
assert float(d.get('amount')) == 5.0, d
assert d.get('currency') == 'EUR', d
methods={m.get('code') for m in d.get('paymentMethods',[])}
for required in ('card','mb_way','bizum','multibanco'):
    assert required in methods, (required, methods)
print('CHECKOUT_SESSION_LOAD=PASS')
print('CHECKOUT_METHODS=PASS')
PY

  docker exec \
    -e REF="$REF" \
    "$CONTAINER" \
    sh -lc 'cd /app && DATABASE_URL="$DIRECT_URL" NODE_PATH=/app/node_modules node' <<'NODE'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const count = await prisma.transaction.count({ where: { reference: process.env.REF } });
  if (count !== 0) throw new Error(`PREINIT_TRANSACTION_EXISTS:${count}`);
  console.log('PREINIT_TRANSACTION_COUNT=0');
})().finally(() => prisma.$disconnect());
NODE

  local INIT_HTTP
  INIT_HTTP="$(curl -sS \
    -o "/tmp/xp-${SLUG}-init.json" \
    -w '%{http_code}' \
    -X POST https://api.xpayments.digital/api/v1/checkout/initiate \
    -H 'Content-Type: application/json' \
    -d "{
      \"sessionId\":\"${SESSION_ID}\",
      \"paymentMethod\":\"mb_way\",
      \"returnUrl\":\"https://checkout.xpayments.digital/pay/${SESSION_ID}?return=1\",
      \"customer\":{
        \"name\":\"${LABEL} Sandbox\",
        \"email\":\"${SLUG}-sandbox@example.com\",
        \"phone\":\"${TEST_PHONE}\"
      }
    }")"

  echo "INIT_HTTP=$INIT_HTTP"
  [ "$INIT_HTTP" = "200" ] || {
    cat "/tmp/xp-${SLUG}-init.json"
    exit 1
  }

  local TX_ID
  TX_ID="$(python3 - "$SLUG" <<'PY'
import json,sys
slug=sys.argv[1]
x=json.load(open(f'/tmp/xp-{slug}-init.json'))
assert x.get('success') is True, x
d=x.get('data') or {}
assert d.get('transactionId'), d
assert d.get('method') == 'mb_way', d
print(d['transactionId'])
PY
  )"

  echo "CHECKOUT_INITIATE_MBWAY=PASS"
  echo "TRANSACTION_ID=$TX_ID"

  local FINAL_STATUS="pending"
  for _ in $(seq 1 30); do
    curl -fsS \
      "https://api.xpayments.digital/api/v1/checkout/session/${SESSION_ID}" \
      >"/tmp/xp-${SLUG}-poll.json"

    FINAL_STATUS="$(python3 - "$SLUG" <<'PY'
import json,sys
slug=sys.argv[1]
x=json.load(open(f'/tmp/xp-{slug}-poll.json'))
print((x.get('data') or {}).get('status','unknown'))
PY
    )"

    [ "$FINAL_STATUS" = "succeeded" ] && break
    { [ "$FINAL_STATUS" = "failed" ] || [ "$FINAL_STATUS" = "expired" ]; } && break
    sleep 2
  done

  echo "CHECKOUT_FINAL_STATUS=$FINAL_STATUS"
  [ "$FINAL_STATUS" = "succeeded" ]
  echo "CHECKOUT_STATUS_RECONCILIATION=PASS"

  docker exec \
    -e TX_ID="$TX_ID" \
    -e SESSION_ID="$SESSION_ID" \
    -e STORE_ID="$STORE_ID" \
    -e MERCHANT_ID="$MERCHANT_ID" \
    -e VAULT_ID="$VAULT_ID" \
    -e PROVIDER="$PROVIDER" \
    "$CONTAINER" \
    sh -lc 'cd /app && DATABASE_URL="$DIRECT_URL" NODE_PATH=/app/node_modules node' <<'NODE'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const tx = await prisma.transaction.findUnique({ where: { id: process.env.TX_ID } });
  const session = await prisma.checkoutSession.findUnique({ where: { id: process.env.SESSION_ID } });
  if (!tx || !session) throw new Error('FINAL_RECORD_MISSING');
  if (tx.storeId !== process.env.STORE_ID) throw new Error(`STORE_BINDING_MISMATCH:${tx.storeId}`);
  if (tx.merchantId !== process.env.MERCHANT_ID) throw new Error(`MERCHANT_BINDING_MISMATCH:${tx.merchantId}`);
  if (tx.gatewayVaultId !== process.env.VAULT_ID) throw new Error(`VAULT_BINDING_MISMATCH:${tx.gatewayVaultId}`);
  if (String(tx.gateway || '').toLowerCase() !== process.env.PROVIDER.toLowerCase()) throw new Error(`PROVIDER_MISMATCH:${tx.gateway}`);
  if (Number(tx.amount) !== 5 || tx.currency !== 'EUR' || tx.method !== 'mb_way' || tx.status !== 'succeeded') {
    throw new Error(`FINAL_TRANSACTION_INVALID:${tx.amount}:${tx.currency}:${tx.method}:${tx.status}`);
  }
  if (session.status !== 'succeeded') throw new Error(`SESSION_STATUS_INVALID:${session.status}`);
  const movements = await prisma.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS count FROM public.wallet_movements WHERE reference = $1',
    tx.id
  );
  const count = movements?.[0]?.count ?? 0;
  if (count < 1) throw new Error(`WALLET_MOVEMENT_MISSING:${count}`);
  console.log('TRANSACTION_STORE_BINDING=PASS');
  console.log('TRANSACTION_MERCHANT_BINDING=PASS');
  console.log('TRANSACTION_VAULT_BINDING=PASS');
  console.log('TRANSACTION_PROVIDER_BINDING=PASS');
  console.log('TRANSACTION_SUCCEEDED=PASS');
  console.log('WALLET_MOVEMENT=PASS');
})().finally(() => prisma.$disconnect());
NODE

  echo "${STORE_CODE}_SANDBOX_E2E=PASS"
  unset API_KEY
}

certify_store \
  "RDEURO-XPAY-SANDBOX" \
  "e933a26b-7ea1-4e32-a268-ebb2d01c326c" \
  "stripe-rdeuro-xpay-sandbox" \
  "RDEuro" \
  "rdeuro"

certify_store \
  "MADOSI-XPAY-SANDBOX" \
  "02e0731c-c9be-4f93-83af-10470a7eeb17" \
  "stripe-madosi-xpay-sandbox" \
  "Madosi" \
  "madosi"

certify_store \
  "HUMANIMPACT-XPAY-SANDBOX" \
  "fa995cc2-87a8-4eb2-bbe5-b65cd9e25777" \
  "stripe-humanimpact-xpay-sandbox" \
  "HumanImpact" \
  "humanimpact"

echo
echo "=== FINAL HEALTH ==="
curl -fsS https://api.xpayments.digital/api/health >/tmp/xp-priority-final-health.json
cat /tmp/xp-priority-final-health.json
printf '\n'
python3 - <<'PY'
import json
x=json.load(open('/tmp/xp-priority-final-health.json'))
assert x.get('status') == 'ONLINE', x
assert x.get('engine') == 'XPayments', x
print('FINAL_HEALTH=PASS')
PY

echo
echo "PRIORITY_SANDBOX_CERTIFICATION=PASS"
echo "REPORT=$REPORT"
