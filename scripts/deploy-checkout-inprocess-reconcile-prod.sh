#!/usr/bin/env bash
set -Eeuo pipefail

APP=/root/xpayments-backend-v3
CONTAINER=xpayments-api-v3
BRANCH=fix/checkout-reconcile-social-sandbox-20260907
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="/root/xpayments-checkout-reconcile-backup-${STAMP}"
REPORT="/root/xpayments-checkout-reconcile-${STAMP}.txt"
CHECKOUT_SRC="src/modules/checkout/controllers/checkout.controller.ts"
DIRECT_SRC="src/modules/payments/controllers/direct.controller.ts"
KNOWN_CHECKOUT_SHA="9b0852d8f90da75b8bb248126e64c2afad0b046be0af4b5f8f0157cf75a21ef9"

exec > >(tee -a "$REPORT") 2>&1

cd "$APP"
mkdir -p "$BACKUP"

echo "======================================================"
echo " XPAYMENTS CHECKOUT — IN-PROCESS STRIPE RECONCILIATION"
echo "======================================================"

echo
echo "=== 0. PRE-FLIGHT ==="
curl -fsS https://api.xpayments.digital/api/health >/tmp/xp-reconcile-health-before.json
cat /tmp/xp-reconcile-health-before.json

git fetch origin "$BRANCH"
echo "PATCH_BRANCH_HEAD=$(git rev-parse origin/$BRANCH)"

test -f "$CHECKOUT_SRC"
test -f "$DIRECT_SRC"

DIRECT_BEFORE="$(sha256sum "$DIRECT_SRC" | awk '{print $1}')"
CHECKOUT_BEFORE="$(sha256sum "$CHECKOUT_SRC" | awk '{print $1}')"

echo "DIRECT_SHA_BEFORE=$DIRECT_BEFORE"
echo "CHECKOUT_SHA_BEFORE=$CHECKOUT_BEFORE"

if grep -q "checkout.internalStripeReconcile" "$CHECKOUT_SRC"; then
  echo "PATCH_ALREADY_PRESENT=YES"
elif [ "$CHECKOUT_BEFORE" != "$KNOWN_CHECKOUT_SHA" ]; then
  echo "UNEXPECTED_CHECKOUT_SOURCE_SHA=$CHECKOUT_BEFORE"
  echo "EXPECTED_CHECKOUT_SOURCE_SHA=$KNOWN_CHECKOUT_SHA"
  echo "ABORT: checkout source changed since certified diagnostic."
  exit 21
fi

cp -a "$CHECKOUT_SRC" "$BACKUP/checkout.controller.ts"
docker cp "$CONTAINER:/app/dist/modules/checkout/controllers/checkout.controller.js" "$BACKUP/checkout.controller.js" 2>/dev/null || true

rollback() {
  echo "ROLLBACK_START=1"
  cp -a "$BACKUP/checkout.controller.ts" "$CHECKOUT_SRC" || true
  if [ -f "$BACKUP/checkout.controller.js" ]; then
    docker cp "$BACKUP/checkout.controller.js" "$CONTAINER:/app/dist/modules/checkout/controllers/checkout.controller.js" || true
  fi
  docker restart "$CONTAINER" >/dev/null || true
  echo "ROLLBACK_COMPLETE=1"
}
trap 'echo "DEPLOY_FAILED=1"; rollback' ERR

echo
echo "=== 1. PATCH CHECKOUT SOURCE ONLY ==="
python3 - <<'PY'
from pathlib import Path

p = Path('/root/xpayments-backend-v3/src/modules/checkout/controllers/checkout.controller.ts')
s = p.read_text()

if 'checkout.internalStripeReconcile' in s:
    print('SOURCE_PATCH=ALREADY_PRESENT')
    raise SystemExit(0)

old_import = "import { executePayment } from '../../payments/services/payment.service';\n"
new_import = old_import + "import { handleStripeWebhook } from '../../payments/controllers/stripe.webhook';\n"
if old_import not in s:
    raise SystemExit('IMPORT_ANCHOR_NOT_FOUND')
s = s.replace(old_import, new_import, 1)

old_const = """const INTERNAL_STRIPE_WEBHOOK_URL =\n  process.env.XPAYMENTS_INTERNAL_STRIPE_WEBHOOK_URL ||\n  'http://127.0.0.1:8084/api/v1/payments/webhooks/stripe';\n"""
if old_const in s:
    s = s.replace(old_const, '', 1)

old = """    const replayResponse = await fetch(INTERNAL_STRIPE_WEBHOOK_URL, {\n      method: 'POST',\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({\n        id: `evt_xpayments_checkout_reconcile_${providerId}_${paymentIntent.status}`,\n        object: 'event',\n        type: eventType,\n        data: { object: paymentIntent }\n      })\n    });\n\n    if (!replayResponse.ok) {\n      console.warn('[checkout.providerReconcile] internal webhook replay failed', {\n        transactionId: transaction.id,\n        providerId,\n        eventType,\n        status: replayResponse.status\n      });\n      return false;\n    }\n"""

new = """    const metadataTransactionId = String(\n      paymentIntent?.metadata?.nexflowx_transaction_id || ''\n    ).trim();\n    const metadataReference = String(\n      paymentIntent?.metadata?.merchant_reference || ''\n    ).trim();\n    const expectedAmountMinor = Math.round(Number(transaction.amount) * 100);\n    const providerAmountMinor = Number(paymentIntent?.amount);\n    const providerCurrency = String(paymentIntent?.currency || '').toUpperCase();\n\n    if (\n      metadataTransactionId !== String(transaction.id) ||\n      (metadataReference && metadataReference !== String(transaction.reference || '')) ||\n      providerAmountMinor !== expectedAmountMinor ||\n      providerCurrency !== String(transaction.currency || '').toUpperCase()\n    ) {\n      console.warn('[checkout.providerReconcile] provider binding mismatch', {\n        transactionId: transaction.id,\n        providerId,\n        metadataTransactionId: metadataTransactionId || null,\n        metadataReference: metadataReference || null,\n        providerAmountMinor,\n        expectedAmountMinor,\n        providerCurrency,\n        expectedCurrency: String(transaction.currency || '').toUpperCase()\n      });\n      return false;\n    }\n\n    const internalEvent = {\n      id: `evt_xpayments_checkout_reconcile_${providerId}_${paymentIntent.status}`,\n      object: 'event',\n      type: eventType,\n      data: { object: paymentIntent }\n    };\n\n    let internalStatusCode = 200;\n    let internalPayload: any = null;\n\n    const internalReq = { body: internalEvent } as Request;\n    const internalRes = {\n      status(code: number) {\n        internalStatusCode = code;\n        return this;\n      },\n      json(payload: any) {\n        internalPayload = payload;\n        return this;\n      }\n    } as unknown as Response;\n\n    /*\n     * This call is intentionally in-process. The public Stripe webhook route\n     * remains signature-protected. Provider authenticity here comes from the\n     * PaymentIntent retrieval performed with the transaction-bound Vault key\n     * plus the strict transaction/reference/amount/currency checks above.\n     */\n    await handleStripeWebhook(internalReq, internalRes);\n\n    const processedTransactionId = String(internalPayload?.transactionId || '');\n    const processedStatus = String(internalPayload?.status || '').toLowerCase();\n\n    if (\n      internalStatusCode >= 400 ||\n      internalPayload?.received === false ||\n      processedTransactionId !== String(transaction.id) ||\n      processedStatus !== String(paymentIntent.status || '').toLowerCase()\n    ) {\n      console.warn('[checkout.internalStripeReconcile] processor rejected', {\n        transactionId: transaction.id,\n        providerId,\n        eventType,\n        internalStatusCode,\n        processedTransactionId: processedTransactionId || null,\n        processedStatus: processedStatus || null\n      });\n      return false;\n    }\n\n    console.log('[checkout.internalStripeReconcile] processed', {\n      transactionId: transaction.id,\n      providerId,\n      eventType,\n      status: processedStatus\n    });\n"""

if old not in s:
    raise SystemExit('REPLAY_BLOCK_NOT_FOUND')

s = s.replace(old, new, 1)
p.write_text(s)
print('SOURCE_PATCH=PASS')
PY

grep -q "checkout.internalStripeReconcile" "$CHECKOUT_SRC"
grep -q "handleStripeWebhook" "$CHECKOUT_SRC"

DIRECT_AFTER_PATCH="$(sha256sum "$DIRECT_SRC" | awk '{print $1}')"
[ "$DIRECT_BEFORE" = "$DIRECT_AFTER_PATCH" ]
echo "DIRECT_CONTROLLER_SOURCE_UNCHANGED=PASS"

echo
echo "=== 2. ISOLATED TYPESCRIPT COMPILE ==="
docker exec "$CONTAINER" sh -lc '
  set -e
  cd /app
  rm -rf /tmp/xpayments-checkout-reconcile-build
  cat >/tmp/xpayments-checkout-reconcile-tsconfig.json <<"JSON"
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "rootDir": "/app/src",
    "outDir": "/tmp/xpayments-checkout-reconcile-build",
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "moduleResolution": "node",
    "noEmitOnError": true
  },
  "files": [
    "/app/src/modules/checkout/controllers/checkout.controller.ts"
  ]
}
JSON
  ./node_modules/.bin/tsc --project /tmp/xpayments-checkout-reconcile-tsconfig.json
  test -f /tmp/xpayments-checkout-reconcile-build/modules/checkout/controllers/checkout.controller.js
'
echo "TEMP_COMPILE=PASS"

echo
echo "=== 3. INSTALL CHECKOUT ARTIFACT ONLY ==="
docker exec "$CONTAINER" sh -lc '
  set -e
  cp /tmp/xpayments-checkout-reconcile-build/modules/checkout/controllers/checkout.controller.js \
    /app/dist/modules/checkout/controllers/checkout.controller.js
'
echo "ARTIFACT_INSTALL=PASS"

docker restart "$CONTAINER" >/dev/null

for i in $(seq 1 30); do
  if curl -fsS https://api.xpayments.digital/api/health >/tmp/xp-reconcile-health-after.json 2>/dev/null; then
    break
  fi
  sleep 1
done
cat /tmp/xp-reconcile-health-after.json
python3 - <<'PY'
import json
x=json.load(open('/tmp/xp-reconcile-health-after.json'))
assert x.get('status') == 'ONLINE'
assert x.get('engine') == 'XPayments'
print('HEALTH=PASS')
PY

echo
echo "=== 4. HARDENING / S2S PROTECTION ==="
HTTP_WEBHOOK="$(curl -sS -o /tmp/xp-webhook-unsigned.json -w '%{http_code}' -X POST \
  https://api.xpayments.digital/api/v1/payments/webhooks/stripe \
  -H 'Content-Type: application/json' \
  -d '{"id":"evt_unsigned_probe","type":"payment_intent.succeeded","data":{"object":{}}}')"
[ "$HTTP_WEBHOOK" = "400" ] || [ "$HTTP_WEBHOOK" = "401" ]
echo "UNSIGNED_STRIPE_WEBHOOK_REJECTED=PASS:${HTTP_WEBHOOK}"

HTTP_DIRECT="$(curl -sS -o /tmp/xp-direct-unauth.json -w '%{http_code}' -X POST \
  https://api.xpayments.digital/api/v1/payments/charge \
  -H 'Content-Type: application/json' \
  -d '{"amount":100,"currency":"EUR","payment_method_types":["card"]}')"
[ "$HTTP_DIRECT" = "401" ]
echo "S2S_UNAUTH_GUARD=PASS"

DIRECT_FINAL="$(sha256sum "$DIRECT_SRC" | awk '{print $1}')"
[ "$DIRECT_BEFORE" = "$DIRECT_FINAL" ]
echo "DIRECT_CONTROLLER_FINAL_UNCHANGED=PASS"

echo
echo "=== 5. RECOVER KNOWN MB WAY SANDBOX TRANSACTION ==="
KNOWN_SESSION="fbadee51-0bac-4764-a7bf-afcf8128b370"
curl -fsS "https://api.xpayments.digital/api/v1/checkout/session/${KNOWN_SESSION}" >/tmp/xp-known-session.json
cat /tmp/xp-known-session.json
python3 - <<'PY'
import json
x=json.load(open('/tmp/xp-known-session.json'))
d=x.get('data') or {}
assert d.get('status') == 'succeeded', d
print('KNOWN_MBWAY_RECONCILE=PASS')
PY

echo
echo "=== 6. FRESH CHECKOUT SANDBOX E2E ==="
E2E_RC=0
bash "$APP/scripts/test-checkout-vnext-sandbox.sh" || E2E_RC=$?
echo "CHECKOUT_E2E_RC=${E2E_RC}"
[ "$E2E_RC" = "0" ]

echo
echo "=== 7. FINAL ==="
echo "BACKUP=$BACKUP"
echo "REPORT=$REPORT"
echo "XPAYMENTS_CHECKOUT_INPROCESS_RECONCILE=PASS"
trap - ERR
