#!/usr/bin/env bash
set -Eeuo pipefail

CONTAINER=xpayments-api-v3
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
REPORT="/root/xpayments-checkout-vnext-sandbox-${STAMP}.txt"
REF="RZEURO-CHECKOUT-SBX-MBWAY-${STAMP}"
TEST_PHONE="+351911111117"

exec > >(tee -a "$REPORT") 2>&1

echo "======================================================"
echo " XPAYMENTS CHECKOUT VNEXT — SANDBOX E2E"
echo "======================================================"

BUNDLE="$(ls -1t /root/xpayments-sandbox-api-keys-*.env 2>/dev/null | head -1 || true)"
[ -n "$BUNDLE" ] || { echo "SANDBOX_API_KEY_BUNDLE=MISSING"; exit 1; }

set -a
# shellcheck disable=SC1090
source "$BUNDLE"
set +a

[ -n "${XPAY_RZEURO_XPAY_SANDBOX_API_KEY:-}" ] || { echo "RZEURO_SANDBOX_API_KEY=MISSING"; exit 1; }

echo "SANDBOX_KEY_LOADED=PASS"
echo "REFERENCE=$REF"
echo "MBWAY_TEST_SCENARIO=IMMEDIATE_SUCCESS"

INTERNAL_HTTP="$(docker exec "$CONTAINER" sh -lc "node -e \"fetch('http://127.0.0.1:8084/api/health').then(r=>{console.log(r.status);process.exit(r.ok?0:1)}).catch(e=>{console.error(e.message);process.exit(2)})\"")"
[ "$INTERNAL_HTTP" = "200" ]
echo "INTERNAL_API_8084=PASS"

CREATE_JSON="$(curl -fsS \
  -X POST https://api.xpayments.digital/api/v1/checkout/session \
  -H "Authorization: Bearer ${XPAY_RZEURO_XPAY_SANDBOX_API_KEY}" \
  -H 'Content-Type: application/json' \
  -d "{
    \"amount\":500,
    \"currency\":\"EUR\",
    \"reference\":\"${REF}\",
    \"customerEmail\":\"checkout-sandbox@example.com\",
    \"returnUrl\":\"https://example.com/payment-complete\",
    \"metadata\":{
      \"customerName\":\"Cliente Checkout Sandbox\",
      \"description\":\"XPayments Checkout VNext Sandbox\"
    }
  }")"

printf '%s' "$CREATE_JSON" >/tmp/xp-checkout-create.json

SESSION_ID="$(python3 - <<'PY'
import json
x=json.load(open('/tmp/xp-checkout-create.json'))
assert x.get('success') is True, x
d=x.get('data',{})
assert d.get('sessionId') and d.get('checkoutUrl') and d.get('embedUrl'), d
print(d['sessionId'])
PY
)"

echo "CHECKOUT_SESSION_CREATE=PASS"
echo "SESSION_ID=$SESSION_ID"
echo "CHECKOUT_URL=https://checkout.xpayments.digital/pay/${SESSION_ID}"
echo "EMBED_URL=https://checkout.xpayments.digital/embed/${SESSION_ID}"

curl -fsS "https://api.xpayments.digital/api/v1/checkout/session/${SESSION_ID}" >/tmp/xp-checkout-load.json

python3 - <<'PY'
import json
x=json.load(open('/tmp/xp-checkout-load.json'))
assert x.get('success') is True, x
d=x.get('data',{})
assert d.get('status') == 'pending', d
assert float(d.get('amount')) == 5.0, d
assert d.get('currency') == 'EUR', d
methods={m.get('code') for m in d.get('paymentMethods',[])}
for required in ('card','mb_way','bizum','multibanco','stripe_all'):
    assert required in methods, (required, methods)
print('CHECKOUT_SESSION_LOAD=PASS')
print('CHECKOUT_METHODS=PASS')
print('CHECKOUT_STRIPE_DYNAMIC=PASS')
PY

docker exec -e REF="$REF" "$CONTAINER" sh -lc 'cd /app && DATABASE_URL="$DIRECT_URL" NODE_PATH=/app/node_modules node' <<'NODE'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const count = await prisma.transaction.count({ where: { reference: process.env.REF } });
  if (count !== 0) throw new Error(`PREINIT_TRANSACTION_EXISTS:${count}`);
  console.log('CHECKOUT_PREINIT_TRANSACTION_COUNT=0');
})().finally(() => prisma.$disconnect());
NODE

INIT_HTTP="$(curl -sS \
  -o /tmp/xp-checkout-init.json \
  -w '%{http_code}' \
  -X POST https://api.xpayments.digital/api/v1/checkout/initiate \
  -H 'Content-Type: application/json' \
  -d "{
    \"sessionId\":\"${SESSION_ID}\",
    \"paymentMethod\":\"mb_way\",
    \"returnUrl\":\"https://checkout.xpayments.digital/pay/${SESSION_ID}?return=1\",
    \"customer\":{
      \"name\":\"Cliente Checkout Sandbox\",
      \"email\":\"checkout-sandbox@example.com\",
      \"phone\":\"${TEST_PHONE}\"
    }
  }")"

echo "INIT_HTTP=$INIT_HTTP"

if [ "$INIT_HTTP" != "200" ]; then
  python3 - <<'PY'
import json
try:
    x=json.load(open('/tmp/xp-checkout-init.json'))
    print('INIT_ERROR=' + json.dumps({'success':x.get('success'),'error':x.get('error'),'message':x.get('message')}, ensure_ascii=False))
except Exception as e:
    print('INIT_ERROR_UNPARSEABLE=' + str(e))
PY
  exit 1
fi

TX_ID="$(python3 - <<'PY'
import json
x=json.load(open('/tmp/xp-checkout-init.json'))
assert x.get('success') is True, x
d=x.get('data',{})
assert d.get('transactionId'), d
assert d.get('method') == 'mb_way', d
assert d.get('checkoutData',{}).get('providerTxId'), d
print(d['transactionId'])
PY
)"

echo "CHECKOUT_INITIATE_MBWAY=PASS"
echo "TRANSACTION_ID=$TX_ID"

docker exec -e TX_ID="$TX_ID" "$CONTAINER" sh -lc 'cd /app && DATABASE_URL="$DIRECT_URL" NODE_PATH=/app/node_modules node' <<'NODE'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const tx = await prisma.transaction.findUnique({ where: { id: process.env.TX_ID } });
  if (!tx) throw new Error('TRANSACTION_NOT_FOUND_AFTER_INIT');
  if (Number(tx.amount) !== 5) throw new Error(`INVALID_TRANSACTION_AMOUNT:${tx.amount}`);
  if (tx.method !== 'mb_way') throw new Error(`INVALID_METHOD_AFTER_INIT:${tx.method}`);
  console.log('CHECKOUT_INIT_TRANSACTION_METHOD=mb_way');
  console.log('TRANSACTION_AMOUNT_MAJOR_UNITS=PASS');
})().finally(() => prisma.$disconnect());
NODE

FINAL_STATUS="pending"
for i in $(seq 1 20); do
  curl -fsS "https://api.xpayments.digital/api/v1/checkout/session/${SESSION_ID}" >/tmp/xp-checkout-poll.json
  FINAL_STATUS="$(python3 - <<'PY'
import json
x=json.load(open('/tmp/xp-checkout-poll.json'))
print(x.get('data',{}).get('status','unknown'))
PY
)"
  [ "$FINAL_STATUS" = "succeeded" ] && break
  { [ "$FINAL_STATUS" = "failed" ] || [ "$FINAL_STATUS" = "expired" ]; } && break
  sleep 2
done

echo "CHECKOUT_FINAL_STATUS=$FINAL_STATUS"
[ "$FINAL_STATUS" = "succeeded" ]
echo "CHECKOUT_STATUS_RECONCILIATION=PASS"

docker exec -e TX_ID="$TX_ID" -e SESSION_ID="$SESSION_ID" "$CONTAINER" sh -lc 'cd /app && DATABASE_URL="$DIRECT_URL" NODE_PATH=/app/node_modules node' <<'NODE'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const tx = await prisma.transaction.findUnique({ where: { id: process.env.TX_ID } });
  const session = await prisma.checkoutSession.findUnique({ where: { id: process.env.SESSION_ID } });
  if (!tx || !session) throw new Error('FINAL_RECORD_MISSING');
  if (Number(tx.amount) !== 5 || tx.currency !== 'EUR' || tx.method !== 'mb_way' || tx.status !== 'succeeded') {
    throw new Error(`FINAL_TRANSACTION_INVALID:${tx.amount}:${tx.currency}:${tx.method}:${tx.status}`);
  }
  if (session.status !== 'succeeded') throw new Error(`INVALID_SESSION_STATUS:${session.status}`);
  const movements = await prisma.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS count FROM public.wallet_movements WHERE reference = $1',
    process.env.TX_ID
  );
  const walletMovements = movements?.[0]?.count ?? 0;
  if (walletMovements < 1) throw new Error(`WALLET_MOVEMENT_MISSING:${walletMovements}`);
  console.log(JSON.stringify({
    transactionId: tx.id,
    amount: Number(tx.amount),
    currency: tx.currency,
    status: tx.status,
    method: tx.method,
    checkoutStatus: session.status,
    walletMovements
  }, null, 2));
  console.log('CHECKOUT_WALLET_MOVEMENT=PASS');
})().finally(() => prisma.$disconnect());
NODE

echo "CHECKOUT_SANDBOX_E2E=PASS"
echo "REPORT=$REPORT"
unset XPAY_RZEURO_XPAY_SANDBOX_API_KEY
