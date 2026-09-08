#!/usr/bin/env bash
set -Eeuo pipefail

PROD_ROOT="/root/xpayments-backend-v3"
CONTAINER="xpayments-api-v3"
AUTH_COMMIT="2e63aa83a806feb4d4a3bf51566c4a1040cd9c65"
EXPECTED_AUTH_CURRENT="866c27da5e2fc7a75af09c81f0c9991d05e6b1fdc6582d3d7bd02c7edc31bf11"
EXPECTED_DIRECT="f4ac2ee6f982ed98f59b90ce45ec6b12691ed31bd1e84472510cbec90e696b32"
EXPECTED_ROUTES="31efe0f9e5d87b3224c7fb55042b4ea8f79ddd3b43b61cce6b5bd910d28a37e5"
EXPECTED_WEBHOOK="968826914cf620126ebcb675939518aa2685bc45715e7c6e6aec3b619ec64bfa"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BUILD="/root/xpayments-onboarding-build-${STAMP}"
BACKUP="/root/xpayments-onboarding-backup-${STAMP}"
AUTH_SRC="src/modules/auth/controllers/auth.controller.ts"
CONTAINER_AUTH="/app/dist/modules/auth/controllers/auth.controller.js"

health() { curl -fsS https://api.xpayments.digital/api/health; }
fail() { echo "$1=FAIL"; exit 1; }

rollback() {
  trap - ERR
  set +e
  echo "ROLLBACK_START=YES"
  [ -f "$BACKUP/auth.controller.ts" ] && cp "$BACKUP/auth.controller.ts" "$PROD_ROOT/$AUTH_SRC"
  [ -f "$BACKUP/auth.controller.host.js" ] && cp "$BACKUP/auth.controller.host.js" "$PROD_ROOT/dist/modules/auth/controllers/auth.controller.js"
  [ -f "$BACKUP/auth.controller.container.js" ] && docker cp "$BACKUP/auth.controller.container.js" "$CONTAINER:$CONTAINER_AUTH" >/dev/null 2>&1
  docker restart "$CONTAINER" >/dev/null 2>&1
  sleep 3
  health || true
  echo
  echo "ROLLBACK_COMPLETE=YES"
}

cd "$PROD_ROOT"
mkdir -p "$BACKUP"

echo "=== PRE HEALTH ==="
health
echo
echo "PRE_HEALTH=PASS"

AUTH_NOW="$(sha256sum "$AUTH_SRC" | awk '{print $1}')"
DIRECT_NOW="$(sha256sum src/modules/payments/controllers/direct.controller.ts | awk '{print $1}')"
ROUTES_NOW="$(sha256sum src/modules/payments/routes/payments.routes.ts | awk '{print $1}')"
WEBHOOK_NOW="$(sha256sum src/modules/payments/controllers/stripe.webhook.ts | awk '{print $1}')"

echo "AUTH_CURRENT_SHA=$AUTH_NOW"
echo "DIRECT_SHA=$DIRECT_NOW"
echo "ROUTES_SHA=$ROUTES_NOW"
echo "WEBHOOK_SHA=$WEBHOOK_NOW"

[ "$AUTH_NOW" = "$EXPECTED_AUTH_CURRENT" ] || fail "AUTH_BASELINE"
[ "$DIRECT_NOW" = "$EXPECTED_DIRECT" ] || fail "DIRECT_INVARIANT"
[ "$ROUTES_NOW" = "$EXPECTED_ROUTES" ] || fail "ROUTES_INVARIANT"
[ "$WEBHOOK_NOW" = "$EXPECTED_WEBHOOK" ] || fail "WEBHOOK_INVARIANT"

echo "BASELINE_GATES=PASS"

VERIFIER_DIST="$(docker exec "$CONTAINER" sh -lc "find /app/dist -type f -name 'stripe-webhook-verification.service.js' -print -quit")"
[ -n "$VERIFIER_DIST" ] || fail "VERIFIER_FOUND"
docker exec "$CONTAINER" grep -q "STRIPE WEBHOOK SHARED VAULT RESOLVED" "$VERIFIER_DIST" || fail "SHARED_VAULT_RUNTIME"
echo "SHARED_VAULT_RUNTIME=PASS"

echo "=== ISOLATED BUILD ==="
git fetch origin feat/merchant-onboarding-sandbox-20260908 >/dev/null 2>&1
git cat-file -e "${AUTH_COMMIT}^{commit}" 2>/dev/null || fail "AUTH_COMMIT_AVAILABLE"
[ -x "$PROD_ROOT/node_modules/.bin/tsc" ] || fail "TSC_AVAILABLE"
rm -rf "$BUILD"
mkdir -p "$BUILD"
git archive "$AUTH_COMMIT" | tar -x -C "$BUILD"
ln -s "$PROD_ROOT/node_modules" "$BUILD/node_modules"
(
  cd "$BUILD"
  "$PROD_ROOT/node_modules/.bin/tsc" -p tsconfig.json
)

NEW_SRC="$BUILD/$AUTH_SRC"
NEW_JS="$BUILD/dist/modules/auth/controllers/auth.controller.js"
[ -s "$NEW_SRC" ] || fail "NEW_AUTH_SOURCE"
[ -s "$NEW_JS" ] || fail "NEW_AUTH_COMPILED"
grep -q "DEFAULT_SHARED_SANDBOX_SOURCE_VAULT_ID" "$NEW_SRC" || fail "SOURCE_VAULT_MARKER"
grep -q "objectValue" "$NEW_SRC" || fail "CREDENTIAL_NORMALIZER_MARKER"
grep -q "XPAY Sandbox" "$NEW_SRC" || fail "XPAY_SANDBOX_MARKER"
grep -q "payments_write" "$NEW_SRC" || fail "PAYMENTS_WRITE_MARKER"
echo "ISOLATED_TYPESCRIPT_BUILD=PASS"
echo "ONBOARDING_MARKERS=PASS"

echo "=== BACKUP AUTH ONLY ==="
cp "$AUTH_SRC" "$BACKUP/auth.controller.ts"
if [ -f dist/modules/auth/controllers/auth.controller.js ]; then
  cp dist/modules/auth/controllers/auth.controller.js "$BACKUP/auth.controller.host.js"
fi
docker cp "$CONTAINER:$CONTAINER_AUTH" "$BACKUP/auth.controller.container.js" >/dev/null
chmod 600 "$BACKUP"/*
echo "AUTH_BACKUP=PASS"

trap 'echo "UNEXPECTED_ERROR_AFTER_INSTALL=YES"; rollback' ERR

echo "=== SURGICAL INSTALL ==="
cp "$NEW_SRC" "$AUTH_SRC"
if [ -d dist/modules/auth/controllers ]; then
  cp "$NEW_JS" dist/modules/auth/controllers/auth.controller.js
fi
docker cp "$NEW_JS" "$CONTAINER:$CONTAINER_AUTH" >/dev/null
echo "AUTH_INSTALL=PASS"

echo "=== RESTART API — NO RECREATE ==="
docker restart "$CONTAINER" >/dev/null

OK=0
for _ in $(seq 1 30); do
  if health >/tmp/xpayments-onboarding-health.json 2>/dev/null; then
    OK=1
    cat /tmp/xpayments-onboarding-health.json
    echo
    break
  fi
  sleep 1
done

if [ "$OK" -ne 1 ]; then
  echo "HEALTH_AFTER_DEPLOY=FAIL"
  rollback
  exit 1
fi
echo "HEALTH_AFTER_DEPLOY=PASS"

[ "$(sha256sum src/modules/payments/controllers/direct.controller.ts | awk '{print $1}')" = "$EXPECTED_DIRECT" ] || { rollback; exit 1; }
[ "$(sha256sum src/modules/payments/routes/payments.routes.ts | awk '{print $1}')" = "$EXPECTED_ROUTES" ] || { rollback; exit 1; }
[ "$(sha256sum src/modules/payments/controllers/stripe.webhook.ts | awk '{print $1}')" = "$EXPECTED_WEBHOOK" ] || { rollback; exit 1; }
docker exec "$CONTAINER" grep -q "STRIPE WEBHOOK SHARED VAULT RESOLVED" "$VERIFIER_DIST" || { rollback; exit 1; }

echo "DIRECT_FINAL_UNCHANGED=PASS"
echo "ROUTES_FINAL_UNCHANGED=PASS"
echo "WEBHOOK_FINAL_UNCHANGED=PASS"
echo "SHARED_VAULT_FINAL=PASS"

echo "=== FINAL HEALTH ==="
health
echo
echo "FINAL_HEALTH=PASS"
echo "MERCHANT_ONBOARDING_RUNTIME_DEPLOY=PASS"
trap - ERR
