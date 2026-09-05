#!/usr/bin/env bash
set -Eeuo pipefail

APP=/root/xpayments-backend-v3
CONTAINER=xpayments-api-v3
REMOTE_REF=origin/feat/checkout-vnext-20260905
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="/root/xpayments-checkout-vnext-backup-${STAMP}"
REPORT="/root/xpayments-checkout-vnext-deploy-${STAMP}.txt"

exec > >(tee -a "$REPORT") 2>&1

echo "======================================================"
echo " XPAYMENTS CHECKOUT VNEXT — ISOLATED PROD DEPLOY"
echo "======================================================"

cd "$APP"
mkdir -p "$BACKUP/src" "$BACKUP/dist"

DIRECT_SRC="src/modules/payments/controllers/direct.controller.ts"
CHECKOUT_SRC="src/modules/checkout/controllers/checkout.controller.ts"
BRIDGE_SRC="src/modules/checkout/services/checkout-orchestrator.service.ts"
PAYMENT_SRC="src/modules/payments/services/payment.service.ts"
MERCHANT_SRC="src/modules/merchant/controllers/merchant.controller.ts"
MERCHANT_ROUTE_SRC="src/modules/merchant/routes/merchant.routes.ts"

DIRECT_BEFORE="$(sha256sum "$DIRECT_SRC" | awk '{print $1}')"
echo "DIRECT_CONTROLLER_SHA_BEFORE=$DIRECT_BEFORE"

git fetch origin feat/checkout-vnext-20260905

for FILE in "$CHECKOUT_SRC" "$BRIDGE_SRC" "$PAYMENT_SRC" "$MERCHANT_SRC" "$MERCHANT_ROUTE_SRC"; do
  git cat-file -e "$REMOTE_REF:$FILE"
done

cp -a "$CHECKOUT_SRC" "$BACKUP/src/checkout.controller.ts"
cp -a "$PAYMENT_SRC" "$BACKUP/src/payment.service.ts"
cp -a "$MERCHANT_SRC" "$BACKUP/src/merchant.controller.ts"
cp -a "$MERCHANT_ROUTE_SRC" "$BACKUP/src/merchant.routes.ts"
if [ -f "$BRIDGE_SRC" ]; then cp -a "$BRIDGE_SRC" "$BACKUP/src/checkout-orchestrator.service.ts"; fi

docker cp "$CONTAINER:/app/dist/modules/checkout/controllers/checkout.controller.js" "$BACKUP/dist/checkout.controller.js" 2>/dev/null || true
docker cp "$CONTAINER:/app/dist/modules/payments/services/payment.service.js" "$BACKUP/dist/payment.service.js" 2>/dev/null || true
docker cp "$CONTAINER:/app/dist/modules/checkout/services/checkout-orchestrator.service.js" "$BACKUP/dist/checkout-orchestrator.service.js" 2>/dev/null || true
docker cp "$CONTAINER:/app/dist/modules/merchant/controllers/merchant.controller.js" "$BACKUP/dist/merchant.controller.js" 2>/dev/null || true
docker cp "$CONTAINER:/app/dist/modules/merchant/routes/merchant.routes.js" "$BACKUP/dist/merchant.routes.js" 2>/dev/null || true

rollback() {
  echo "ROLLBACK_START=1"
  cp -a "$BACKUP/src/checkout.controller.ts" "$CHECKOUT_SRC" || true
  cp -a "$BACKUP/src/payment.service.ts" "$PAYMENT_SRC" || true
  cp -a "$BACKUP/src/merchant.controller.ts" "$MERCHANT_SRC" || true
  cp -a "$BACKUP/src/merchant.routes.ts" "$MERCHANT_ROUTE_SRC" || true
  if [ -f "$BACKUP/src/checkout-orchestrator.service.ts" ]; then
    mkdir -p "$(dirname "$BRIDGE_SRC")"
    cp -a "$BACKUP/src/checkout-orchestrator.service.ts" "$BRIDGE_SRC" || true
  else
    rm -f "$BRIDGE_SRC" || true
  fi

  for PAIR in \
    "$BACKUP/dist/checkout.controller.js|$CONTAINER:/app/dist/modules/checkout/controllers/checkout.controller.js" \
    "$BACKUP/dist/payment.service.js|$CONTAINER:/app/dist/modules/payments/services/payment.service.js" \
    "$BACKUP/dist/checkout-orchestrator.service.js|$CONTAINER:/app/dist/modules/checkout/services/checkout-orchestrator.service.js" \
    "$BACKUP/dist/merchant.controller.js|$CONTAINER:/app/dist/modules/merchant/controllers/merchant.controller.js" \
    "$BACKUP/dist/merchant.routes.js|$CONTAINER:/app/dist/modules/merchant/routes/merchant.routes.js"; do
      SRC="${PAIR%%|*}"
      DST="${PAIR#*|}"
      [ -f "$SRC" ] && docker cp "$SRC" "$DST" || true
  done

  docker restart "$CONTAINER" >/dev/null || true
  echo "ROLLBACK_COMPLETE=1"
}
trap 'echo "DEPLOY_FAILED=1"; rollback' ERR

mkdir -p "$(dirname "$BRIDGE_SRC")"
git show "$REMOTE_REF:$CHECKOUT_SRC" > "$CHECKOUT_SRC"
git show "$REMOTE_REF:$BRIDGE_SRC" > "$BRIDGE_SRC"
git show "$REMOTE_REF:$PAYMENT_SRC" > "$PAYMENT_SRC"
git show "$REMOTE_REF:$MERCHANT_SRC" > "$MERCHANT_SRC"
git show "$REMOTE_REF:$MERCHANT_ROUTE_SRC" > "$MERCHANT_ROUTE_SRC"

DIRECT_AFTER_SOURCE="$(sha256sum "$DIRECT_SRC" | awk '{print $1}')"
[ "$DIRECT_BEFORE" = "$DIRECT_AFTER_SOURCE" ]
echo "DIRECT_CONTROLLER_SOURCE_UNCHANGED=PASS"

echo "=== TEMP TYPESCRIPT COMPILE ==="
docker exec "$CONTAINER" sh -lc '
  set -e
  cd /app
  rm -rf /tmp/xpayments-checkout-vnext-build
  rm -f /tmp/xpayments-checkout-vnext-tsconfig.json

  cat >/tmp/xpayments-checkout-vnext-tsconfig.json <<"JSON"
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "rootDir": "/app/src",
    "outDir": "/tmp/xpayments-checkout-vnext-build",
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "moduleResolution": "node",
    "noEmitOnError": true
  },
  "files": [
    "/app/src/modules/checkout/controllers/checkout.controller.ts",
    "/app/src/modules/checkout/services/checkout-orchestrator.service.ts",
    "/app/src/modules/payments/services/payment.service.ts",
    "/app/src/modules/merchant/controllers/merchant.controller.ts",
    "/app/src/modules/merchant/routes/merchant.routes.ts"
  ]
}
JSON

  ./node_modules/.bin/tsc --project /tmp/xpayments-checkout-vnext-tsconfig.json

  test -f /tmp/xpayments-checkout-vnext-build/modules/checkout/controllers/checkout.controller.js
  test -f /tmp/xpayments-checkout-vnext-build/modules/checkout/services/checkout-orchestrator.service.js
  test -f /tmp/xpayments-checkout-vnext-build/modules/payments/services/payment.service.js
  test -f /tmp/xpayments-checkout-vnext-build/modules/merchant/controllers/merchant.controller.js
  test -f /tmp/xpayments-checkout-vnext-build/modules/merchant/routes/merchant.routes.js
'
echo "TEMP_COMPILE=PASS"

echo "=== INSTALL ONLY CHECKOUT/BRANDING ARTIFACTS ==="
docker exec "$CONTAINER" sh -lc '
  set -e
  mkdir -p /app/dist/modules/checkout/controllers
  mkdir -p /app/dist/modules/checkout/services
  mkdir -p /app/dist/modules/payments/services
  mkdir -p /app/dist/modules/merchant/controllers
  mkdir -p /app/dist/modules/merchant/routes
  cp /tmp/xpayments-checkout-vnext-build/modules/checkout/controllers/checkout.controller.js /app/dist/modules/checkout/controllers/checkout.controller.js
  cp /tmp/xpayments-checkout-vnext-build/modules/checkout/services/checkout-orchestrator.service.js /app/dist/modules/checkout/services/checkout-orchestrator.service.js
  cp /tmp/xpayments-checkout-vnext-build/modules/payments/services/payment.service.js /app/dist/modules/payments/services/payment.service.js
  cp /tmp/xpayments-checkout-vnext-build/modules/merchant/controllers/merchant.controller.js /app/dist/modules/merchant/controllers/merchant.controller.js
  cp /tmp/xpayments-checkout-vnext-build/modules/merchant/routes/merchant.routes.js /app/dist/modules/merchant/routes/merchant.routes.js
'
echo "ARTIFACT_INSTALL=PASS"

docker restart "$CONTAINER" >/dev/null

for i in $(seq 1 20); do
  if curl -fsS https://api.xpayments.digital/api/health >/tmp/xp-health.json 2>/dev/null; then break; fi
  sleep 1
done

cat /tmp/xp-health.json
python3 - <<'PY'
import json
x=json.load(open('/tmp/xp-health.json'))
assert x.get('status') == 'ONLINE'
assert x.get('engine') == 'XPayments'
print('HEALTH=PASS')
PY

HTTP_DIRECT="$(curl -sS -o /tmp/xp-direct-smoke.json -w '%{http_code}' -X POST https://api.xpayments.digital/api/v1/payments/charge -H 'Content-Type: application/json' -d '{"amount":100,"currency":"EUR","payment_method_types":["card"]}')"
[ "$HTTP_DIRECT" = "401" ]
echo "S2S_UNAUTH_SMOKE=PASS"

HTTP_CREATE="$(curl -sS -o /tmp/xp-checkout-create-smoke.json -w '%{http_code}' -X POST https://api.xpayments.digital/api/v1/checkout/session -H 'Content-Type: application/json' -d '{"amount":500,"currency":"EUR"}')"
[ "$HTTP_CREATE" = "401" ]
echo "CHECKOUT_AUTH_SMOKE=PASS"

HTTP_BAD_UUID="$(curl -sS -o /tmp/xp-checkout-uuid-smoke.json -w '%{http_code}' https://api.xpayments.digital/api/v1/checkout/session/not-a-uuid)"
[ "$HTTP_BAD_UUID" = "400" ]
echo "CHECKOUT_UUID_SMOKE=PASS"

HTTP_BRAND_UNAUTH="$(curl -sS -o /tmp/xp-brand-smoke.json -w '%{http_code}' -X PUT https://api.xpayments.digital/api/v1/merchant/stores/00000000-0000-0000-0000-000000000000/checkout-branding -H 'Content-Type: application/json' -d '{}')"
[ "$HTTP_BRAND_UNAUTH" = "401" ]
echo "CHECKOUT_BRANDING_AUTH_SMOKE=PASS"

DIRECT_FINAL="$(sha256sum "$DIRECT_SRC" | awk '{print $1}')"
[ "$DIRECT_BEFORE" = "$DIRECT_FINAL" ]
echo "DIRECT_CONTROLLER_FINAL_UNCHANGED=PASS"

echo "BACKUP=$BACKUP"
echo "REPORT=$REPORT"
echo "CHECKOUT_VNEXT_PROD_DEPLOY=PASS"
trap - ERR
