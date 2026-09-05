#!/usr/bin/env bash
set -Eeuo pipefail

APP=/root/xpayments-backend-v3
CONTAINER=xpayments-api-v3
REMOTE_REF=origin/feat/checkout-vnext-20260905
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="/root/xpayments-checkout-branding-backup-${STAMP}"
REPORT="/root/xpayments-checkout-branding-deploy-${STAMP}.txt"

exec > >(tee -a "$REPORT") 2>&1

cd "$APP"
mkdir -p "$BACKUP/src" "$BACKUP/dist"

echo "======================================================"
echo " XPAYMENTS CHECKOUT BRANDING — ISOLATED PROD DEPLOY"
echo "======================================================"

DIRECT_SRC="src/modules/payments/controllers/direct.controller.ts"
MERCHANT_CONTROLLER="src/modules/merchant/controllers/merchant.controller.ts"
MERCHANT_ROUTES="src/modules/merchant/routes/merchant.routes.ts"

DIRECT_BEFORE="$(sha256sum "$DIRECT_SRC" | awk '{print $1}')"
echo "DIRECT_CONTROLLER_SHA_BEFORE=$DIRECT_BEFORE"

git fetch origin feat/checkout-vnext-20260905

git cat-file -e "$REMOTE_REF:$MERCHANT_CONTROLLER"
git cat-file -e "$REMOTE_REF:$MERCHANT_ROUTES"

cp -a "$MERCHANT_CONTROLLER" "$BACKUP/src/merchant.controller.ts"
cp -a "$MERCHANT_ROUTES" "$BACKUP/src/merchant.routes.ts"
docker cp "$CONTAINER:/app/dist/modules/merchant/controllers/merchant.controller.js" "$BACKUP/dist/merchant.controller.js" 2>/dev/null || true
docker cp "$CONTAINER:/app/dist/modules/merchant/routes/merchant.routes.js" "$BACKUP/dist/merchant.routes.js" 2>/dev/null || true

rollback() {
  echo "BRANDING_ROLLBACK_START=1"
  cp -a "$BACKUP/src/merchant.controller.ts" "$MERCHANT_CONTROLLER" || true
  cp -a "$BACKUP/src/merchant.routes.ts" "$MERCHANT_ROUTES" || true
  if [ -f "$BACKUP/dist/merchant.controller.js" ]; then
    docker cp "$BACKUP/dist/merchant.controller.js" "$CONTAINER:/app/dist/modules/merchant/controllers/merchant.controller.js" || true
  fi
  if [ -f "$BACKUP/dist/merchant.routes.js" ]; then
    docker cp "$BACKUP/dist/merchant.routes.js" "$CONTAINER:/app/dist/modules/merchant/routes/merchant.routes.js" || true
  fi
  docker restart "$CONTAINER" >/dev/null || true
  echo "BRANDING_ROLLBACK_COMPLETE=1"
}
trap 'echo "BRANDING_DEPLOY_FAILED=1"; rollback' ERR

git show "$REMOTE_REF:$MERCHANT_CONTROLLER" > "$MERCHANT_CONTROLLER"
git show "$REMOTE_REF:$MERCHANT_ROUTES" > "$MERCHANT_ROUTES"

DIRECT_AFTER_SOURCE="$(sha256sum "$DIRECT_SRC" | awk '{print $1}')"
[ "$DIRECT_BEFORE" = "$DIRECT_AFTER_SOURCE" ]
echo "DIRECT_CONTROLLER_SOURCE_UNCHANGED=PASS"

echo "=== TEMP TYPESCRIPT COMPILE ==="
docker exec "$CONTAINER" sh -lc '
  set -e
  cd /app
  rm -rf /tmp/xpayments-checkout-branding-build
  rm -f /tmp/xpayments-checkout-branding-tsconfig.json
  cat >/tmp/xpayments-checkout-branding-tsconfig.json <<"JSON"
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "rootDir": "/app/src",
    "outDir": "/tmp/xpayments-checkout-branding-build",
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "moduleResolution": "node",
    "noEmitOnError": true
  },
  "files": [
    "/app/src/modules/merchant/controllers/merchant.controller.ts",
    "/app/src/modules/merchant/routes/merchant.routes.ts"
  ]
}
JSON
  ./node_modules/.bin/tsc --project /tmp/xpayments-checkout-branding-tsconfig.json
  test -f /tmp/xpayments-checkout-branding-build/modules/merchant/controllers/merchant.controller.js
  test -f /tmp/xpayments-checkout-branding-build/modules/merchant/routes/merchant.routes.js
'
echo "BRANDING_TEMP_COMPILE=PASS"

echo "=== INSTALL BRANDING ARTIFACTS ==="
docker exec "$CONTAINER" sh -lc '
  set -e
  mkdir -p /app/dist/modules/merchant/controllers /app/dist/modules/merchant/routes
  cp /tmp/xpayments-checkout-branding-build/modules/merchant/controllers/merchant.controller.js /app/dist/modules/merchant/controllers/merchant.controller.js
  cp /tmp/xpayments-checkout-branding-build/modules/merchant/routes/merchant.routes.js /app/dist/modules/merchant/routes/merchant.routes.js
'
echo "BRANDING_ARTIFACT_INSTALL=PASS"

docker restart "$CONTAINER" >/dev/null

for i in $(seq 1 20); do
  if curl -fsS https://api.xpayments.digital/api/health >/tmp/xp-branding-health.json 2>/dev/null; then break; fi
  sleep 1
done
python3 - <<'PY'
import json
x=json.load(open('/tmp/xp-branding-health.json'))
assert x.get('status') == 'ONLINE'
assert x.get('engine') == 'XPayments'
print('BRANDING_HEALTH=PASS')
PY

HTTP_GET="$(curl -sS -o /tmp/xp-branding-get.json -w '%{http_code}' https://api.xpayments.digital/api/v1/merchant/stores/00000000-0000-0000-0000-000000000000)"
[ "$HTTP_GET" = "401" ]
echo "BRANDING_GET_AUTH_GUARD=PASS"

HTTP_PUT="$(curl -sS -o /tmp/xp-branding-put.json -w '%{http_code}' -X PUT https://api.xpayments.digital/api/v1/merchant/stores/00000000-0000-0000-0000-000000000000/checkout-branding -H 'Content-Type: application/json' -d '{}')"
[ "$HTTP_PUT" = "401" ]
echo "BRANDING_PUT_AUTH_GUARD=PASS"

DIRECT_FINAL="$(sha256sum "$DIRECT_SRC" | awk '{print $1}')"
[ "$DIRECT_BEFORE" = "$DIRECT_FINAL" ]
echo "DIRECT_CONTROLLER_FINAL_UNCHANGED=PASS"
echo "BACKUP=$BACKUP"
echo "REPORT=$REPORT"
echo "CHECKOUT_BRANDING_PROD_DEPLOY=PASS"
trap - ERR
