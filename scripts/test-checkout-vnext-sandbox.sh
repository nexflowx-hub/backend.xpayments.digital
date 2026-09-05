#!/usr/bin/env bash
set -Eeuo pipefail

CONTAINER=xpayments-api-v3
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
REPORT="/root/xpayments-checkout-vnext-sandbox-${STAMP}.txt"
REF="RZEURO-CHECKOUT-SBX-MBWAY-${STAMP}"

exec > >(tee -a "$REPORT") 2>&1

echo "======================================================"
echo " XPAYMENTS CHECKOUT VNEXT — SANDBOX E2E"
echo "======================================================"

BUNDLE="$(ls -1t /root/xpayments-sandbox-api-keys-*.env 2>/dev/null | head -1 || true)"
if [ -z "$BUNDLE" ]; then
  echo "SANDBOX_API_KEY_BUNDLE=MISSING"
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$BUNDLE"
set +a

if [ -z "${XPAY_RZEURO_XPAY_SANDBOX_API_KEY:-}" ]; then
  echo "RZEURO_SANDBOX_API_KEY=MISSING"
  exit 1
fi

echo "SANDBOX_KEY_LOADED=PASS"
echo "REFERENCE=$REF"

INTERNAL_HTTP="$(docker exec "$CONTAINER" sh -lc "node -e \"fetch('http://127.0.0.1:8084/api/health').then(async r=>{console.log(r.status);process.exit(r.ok?0:1)}).catch(e=>{console.error(e.message);process.exit(2)})\"")"
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
    \"metadata\":{
      \"customerName\":\"Cliente Checkout Sandbox\",
      \"customerEmail\":\"checkout-sandbox@example.com\",
      \"description\":\"XPayments Checkout VNext Sandbox\",
      \"primaryColor\":\"#111111\"
    }
  }")"

printf '%s' "$CREATE_JSON" >/tmp/xp-checkout-create.json

SESSION_ID="$(python3 - <<'PY'
import json
x=json.load(open('/tmp/xp-checkout-create.json'))
assert x.get('success') is True, x
sid=x.get('data',{}).get('sessionId')
assert sid, x
print(sid)
PY
)"

CHECKOUT_URL="$(python3 - <<'PY'
import json
x=json.load(open('/tmp/xp-checkout-create.json'))
print(x.get('data',{}).get('checkoutUrl',''))
PY
)"

EMBED_URL="$(python3 - <<'PY'
import json
x=json.load(open('/tmp/xp-checkout-create.json'))
print(x.get('data',{}).get('embedUrl',''))
PY
)"

echo "CHECKOUT_SESSION_CREATE=PASS"
echo "SESSION_ID=$SESSION_ID"
echo "CHECKOUT_URL=$CHECKOUT_URL"
echo "EMBED_URL=$EMBED_URL"

curl -fsS \
  "https://api.xpayments.digital/api/v1/checkout/session/${SESSION_ID}" \
  >/tmp/xp-checkout-load.json

python3 - <<'PY'
import json
x=json.load(open('/tmp/xp-checkout-load.json'))
assert x.get('success') is True, x
d=x.get('data',{})
assert d.get('status') == 'pending', d
assert float(d.get('amount')) == 5.0, d
assert d.get('currency') == 'EUR', d
methods={m.get('code') for m in d.get('paymentMethods',[])}
for required in ('card','mb_way','bizum','multibanco'):
    assert required in methods, (required, methods)
print('CHECKOUT_SESSION_LOAD=PASS')
print('CHECKOUT_METHODS=PASS')
PY

# Guarantee this fresh reference has no pre-existing transaction.
docker exec \
  -e REF="$REF" \
  "$CONTAINER" \
  sh -lc 'cd /app && DATABASE_URL="$DIRECT_URL" NODE_PATH=/app/node_modules node' <<'NODE'
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
      \"phone\":\"+351911111112\"
    }
  }")"

echo "INIT_HTTP=$INIT_HTTP"

if [ "$INIT_HTTP" != "200" ]; then
  python3 - <<'PY'
import json
try:
    x=json.load(open('/tmp/xp-checkout-init.json'))
    safe={
      'success': x.get('success'),
      'error': x.get('error'),
      'message': x.get('message')
    }
    print('INIT_ERROR=' + json.dumps(safe, ensure_ascii=False))
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
tx=d.get('transactionId')
assert tx, d
assert d.get('method') == 'mb_way', d
cd=d.get('checkoutData',{})
assert cd.get('providerTxId'), cd
assert cd.get('status') in ('requires_action','processing','succeeded'), cd
print(tx)
PY
)"

echo "CHECKOUT_INITIATE_MBWAY=PASS"
echo "TRANSACTION_ID=$TX_ID"

docker exec \
  -e TX_ID="$TX_ID" \
  "$CONTAINER" \
  sh -lc 'cd /app && DATABASE_URL="$DIRECT_URL" NODE_PATH=/app/node_modules node' <<'NODE'
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
for i in $(seq 1 40); do
  curl -fsS \
    "https://api.xpayments.digital/api/v1/checkout/session/${SESSION_ID}" \
    >/tmp/xp-checkout-poll.json

  FINAL_STATUS="$(python3 - <<'PY'
import json
x=json.load(open('/tmp/xp-checkout-poll.json'))
print(x.get('data',{}).get('status','unknown'))
PY
)"

  if [ "$FINAL_STATUS" = "succeeded" ]; then
    break
  fi

  if [ "$FINAL_STATUS" = "failed" ] || [ "$FINAL_STATUS" = "expired" ]; then
    break
  fi

  sleep 3
done

echo "CHECKOUT_FINAL_STATUS=$FINAL_STATUS"
[ "$FINAL_STATUS" = "succeeded" ]
echo "CHECKOUT_STATUS_RECONCILIATION=PASS"

docker exec \
  -e TX_ID="$TX_ID" \
  -e SESSION_ID="$SESSION_ID" \
  "$CONTAINER" \
  sh -lc 'cd /app && DATABASE_URL="$DIRECT_URL" NODE_PATH=/app/node_modules node' <<'NODE'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const tx = await prisma.transaction.findUnique({ where: { id: process.env.TX_ID } });
  if (!tx) throw new Error('TRANSACTION_NOT_FOUND');
  if (Number(tx.amount) !== 5) throw new Error(`INVALID_TRANSACTION_AMOUNT:${tx.amount}`);
  if (tx.currency !== 'EUR') throw new Error(`INVALID_CURRENCY:${tx.currency}`);
  if (tx.method !== 'mb_way') throw new Error(`INVALID_METHOD:${tx.method}`);
  if (tx.status !== 'succeeded') throw new Error(`INVALID_STATUS:${tx.status}`);

  const session = await prisma.checkoutSession.findUnique({ where: { id: process.env.SESSION_ID } });
  if (!session) throw new Error('CHECKOUT_SESSION_NOT_FOUND');
  if (session.status !== 'succeeded') throw new Error(`INVALID_SESSION_STATUS:${session.status}`);

  const movements = await prisma.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS count FROM public.wallet_movements WHERE transaction_id = $1::uuid',
    process.env.TX_ID
  );

  console.log(JSON.stringify({
    transactionId: tx.id,
    amount: Number(tx.amount),
    currency: tx.currency,
    status: tx.status,
    method: tx.method,
    fee: tx.fee === null ? null : Number(tx.fee),
    checkoutStatus: session.status,
    walletMovements: movements?.[0]?.count ?? 0
  }, null, 2));
})();
NODE

echo "CHECKOUT_SANDBOX_E2E=PASS"
echo "REPORT=$REPORT"
unset XPAY_RZEURO_XPAY_SANDBOX_API_KEY
