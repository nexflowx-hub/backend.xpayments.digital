#!/usr/bin/env bash
set -Eeuo pipefail

APP=/root/xpayments-backend-v3
CONTAINER=xpayments-api-v3
REMOTE_REF=origin/feat/checkout-vnext-20260905
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="/root/xpayments-developer-key-guard-backup-${STAMP}"
REPORT="/root/xpayments-developer-key-guard-deploy-${STAMP}.txt"

exec > >(tee -a "$REPORT") 2>&1

cd "$APP"
mkdir -p "$BACKUP/src" "$BACKUP/dist"

echo "======================================================"
echo " XPAYMENTS DEVELOPER API-KEY GUARD — ISOLATED DEPLOY"
echo "======================================================"

DIRECT_SRC="src/modules/payments/controllers/direct.controller.ts"
DEV_CONTROLLER="src/modules/developer/controllers/developer.controller.ts"

DIRECT_BEFORE="$(sha256sum "$DIRECT_SRC" | awk '{print $1}')"
echo "DIRECT_CONTROLLER_SHA_BEFORE=$DIRECT_BEFORE"

git fetch origin feat/checkout-vnext-20260905
git cat-file -e "$REMOTE_REF:$DEV_CONTROLLER"

cp -a "$DEV_CONTROLLER" "$BACKUP/src/developer.controller.ts"
docker cp "$CONTAINER:/app/dist/modules/developer/controllers/developer.controller.js" "$BACKUP/dist/developer.controller.js" 2>/dev/null || true

rollback() {
  echo "DEVELOPER_GUARD_ROLLBACK_START=1"
  cp -a "$BACKUP/src/developer.controller.ts" "$DEV_CONTROLLER" || true
  if [ -f "$BACKUP/dist/developer.controller.js" ]; then
    docker cp "$BACKUP/dist/developer.controller.js" "$CONTAINER:/app/dist/modules/developer/controllers/developer.controller.js" || true
  fi
  docker restart "$CONTAINER" >/dev/null || true
  echo "DEVELOPER_GUARD_ROLLBACK_COMPLETE=1"
}
trap 'echo "DEVELOPER_GUARD_DEPLOY_FAILED=1"; rollback' ERR

git show "$REMOTE_REF:$DEV_CONTROLLER" > "$DEV_CONTROLLER"

DIRECT_AFTER_SOURCE="$(sha256sum "$DIRECT_SRC" | awk '{print $1}')"
[ "$DIRECT_BEFORE" = "$DIRECT_AFTER_SOURCE" ]
echo "DIRECT_CONTROLLER_SOURCE_UNCHANGED=PASS"

echo "=== TEMP TYPESCRIPT COMPILE ==="
docker exec "$CONTAINER" sh -lc '
  set -e
  cd /app
  rm -rf /tmp/xpayments-developer-guard-build
  rm -f /tmp/xpayments-developer-guard-tsconfig.json
  cat >/tmp/xpayments-developer-guard-tsconfig.json <<"JSON"
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "rootDir": "/app/src",
    "outDir": "/tmp/xpayments-developer-guard-build",
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "moduleResolution": "node",
    "noEmitOnError": true
  },
  "files": [
    "/app/src/modules/developer/controllers/developer.controller.ts"
  ]
}
JSON
  ./node_modules/.bin/tsc --project /tmp/xpayments-developer-guard-tsconfig.json
  test -f /tmp/xpayments-developer-guard-build/modules/developer/controllers/developer.controller.js
'
echo "DEVELOPER_GUARD_TEMP_COMPILE=PASS"

echo "=== INSTALL DEVELOPER CONTROLLER ==="
docker exec "$CONTAINER" sh -lc '
  set -e
  mkdir -p /app/dist/modules/developer/controllers
  cp /tmp/xpayments-developer-guard-build/modules/developer/controllers/developer.controller.js /app/dist/modules/developer/controllers/developer.controller.js
'
echo "DEVELOPER_GUARD_ARTIFACT_INSTALL=PASS"

docker restart "$CONTAINER" >/dev/null

for i in $(seq 1 20); do
  if curl -fsS https://api.xpayments.digital/api/health >/tmp/xp-developer-guard-health.json 2>/dev/null; then break; fi
  sleep 1
done
python3 - <<'PY'
import json
x=json.load(open('/tmp/xp-developer-guard-health.json'))
assert x.get('status') == 'ONLINE'
assert x.get('engine') == 'XPayments'
print('DEVELOPER_GUARD_HEALTH=PASS')
PY

HTTP_KEYS="$(curl -sS -o /tmp/xp-developer-guard-keys.json -w '%{http_code}' https://api.xpayments.digital/api/v1/api-keys)"
[ "$HTTP_KEYS" = "401" ]
echo "DEVELOPER_GUARD_AUTH=PASS"

DIRECT_FINAL="$(sha256sum "$DIRECT_SRC" | awk '{print $1}')"
[ "$DIRECT_BEFORE" = "$DIRECT_FINAL" ]
echo "DIRECT_CONTROLLER_FINAL_UNCHANGED=PASS"
echo "BACKUP=$BACKUP"
echo "REPORT=$REPORT"
echo "DEVELOPER_API_KEY_GUARD_PROD_DEPLOY=PASS"
trap - ERR
