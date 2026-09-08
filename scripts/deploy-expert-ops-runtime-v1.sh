#!/usr/bin/env bash
set -Eeuo pipefail

PROD_ROOT="/root/xpayments-backend-v3"
CONTAINER="xpayments-api-v3"
BRANCH="fix/checkout-signed-reconcile-20260907"
EXPECTED_DIRECT="f4ac2ee6f982ed98f59b90ce45ec6b12691ed31bd1e84472510cbec90e696b32"
EXPECTED_ROUTES="31efe0f9e5d87b3224c7fb55042b4ea8f79ddd3b43b61cce6b5bd910d28a37e5"
EXPECTED_WEBHOOK="968826914cf620126ebcb675939518aa2685bc45715e7c6e6aec3b619ec64bfa"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BUILD="/root/expert-ops-build-${STAMP}"
BACKUP="/root/expert-ops-backup-${STAMP}"

health(){ curl -fsS https://api.xpayments.digital/api/health; }
fail(){ echo "$1=FAIL"; exit 1; }

rollback(){
  trap - ERR
  set +e
  echo "ROLLBACK_START=YES"
  [ -f "$BACKUP/app.ts" ] && cp "$BACKUP/app.ts" "$PROD_ROOT/src/core/app.ts"
  [ -f "$BACKUP/app.host.js" ] && cp "$BACKUP/app.host.js" "$PROD_ROOT/dist/core/app.js"
  [ -f "$BACKUP/app.container.js" ] && docker cp "$BACKUP/app.container.js" "$CONTAINER:/app/dist/core/app.js" >/dev/null 2>&1
  if [ -f "$BACKUP/expert-ops-source.tgz" ]; then
    rm -rf "$PROD_ROOT/src/modules/expert-ops"
    tar -xzf "$BACKUP/expert-ops-source.tgz" -C "$PROD_ROOT/src/modules"
  else
    rm -rf "$PROD_ROOT/src/modules/expert-ops"
  fi
  if [ -f "$BACKUP/expert-ops-container.tgz" ]; then
    docker exec "$CONTAINER" sh -lc 'rm -rf /app/dist/modules/expert-ops && mkdir -p /app/dist/modules'
    docker cp "$BACKUP/expert-ops-container.tgz" "$CONTAINER:/tmp/expert-ops-container.tgz" >/dev/null 2>&1
    docker exec "$CONTAINER" sh -lc 'tar -xzf /tmp/expert-ops-container.tgz -C /app/dist/modules && rm -f /tmp/expert-ops-container.tgz'
  else
    docker exec "$CONTAINER" sh -lc 'rm -rf /app/dist/modules/expert-ops'
  fi
  docker restart "$CONTAINER" >/dev/null 2>&1
  sleep 3
  health || true
  echo
  echo "ROLLBACK_COMPLETE=YES"
}

cd "$PROD_ROOT"
mkdir -p "$BACKUP"

echo "======================================================"
echo " XPAYMENTS — EXPERT OPERATIONS RUNTIME DEPLOY V1"
echo "======================================================"

echo "=== 1. PRE HEALTH / FINANCIAL GATES ==="
health; echo
[ "$(sha256sum src/modules/payments/controllers/direct.controller.ts | awk '{print $1}')" = "$EXPECTED_DIRECT" ] || fail "DIRECT_PRE"
[ "$(sha256sum src/modules/payments/routes/payments.routes.ts | awk '{print $1}')" = "$EXPECTED_ROUTES" ] || fail "ROUTES_PRE"
[ "$(sha256sum src/modules/payments/controllers/stripe.webhook.ts | awk '{print $1}')" = "$EXPECTED_WEBHOOK" ] || fail "WEBHOOK_PRE"
VERIFIER_DIST="$(docker exec "$CONTAINER" sh -lc "find /app/dist -type f -name 'stripe-webhook-verification.service.js' -print -quit")"
[ -n "$VERIFIER_DIST" ] || fail "VERIFIER_FOUND"
docker exec "$CONTAINER" grep -q "STRIPE WEBHOOK SHARED VAULT RESOLVED" "$VERIFIER_DIST" || fail "SHARED_VAULT_PRE"
docker exec "$CONTAINER" grep -q "XPAY Sandbox" /app/dist/modules/auth/controllers/auth.controller.js || fail "ONBOARDING_AUTH_PRE"
docker exec "$CONTAINER" test -s /app/dist/modules/expert/controllers/expert-payment-instructions.controller.js || fail "EXPERT_RUNTIME_PRE"
echo "FINANCIAL_INVARIANTS_PRE=PASS"
echo "SHARED_VAULT_PRE=PASS"
echo "ONBOARDING_AUTH_PRE=PASS"
echo "EXPERT_RUNTIME_PRE=PASS"

echo "=== 2. ISOLATED BUILD ==="
git fetch origin "$BRANCH" >/dev/null 2>&1
TARGET_COMMIT="$(git rev-parse "origin/$BRANCH")"
echo "TARGET_COMMIT=$TARGET_COMMIT"
rm -rf "$BUILD" && mkdir -p "$BUILD"
git archive "$TARGET_COMMIT" | tar -x -C "$BUILD"
ln -s "$PROD_ROOT/node_modules" "$BUILD/node_modules"
(
  cd "$BUILD"
  "$PROD_ROOT/node_modules/.bin/tsc" -p tsconfig.json
)
[ -s "$BUILD/dist/core/app.js" ] || fail "APP_BUILD"
[ -s "$BUILD/dist/modules/expert-ops/routes/expert-ops.routes.js" ] || fail "OPS_ROUTE_BUILD"
[ -s "$BUILD/dist/modules/expert-ops/controllers/expert-ops.controller.js" ] || fail "OPS_CONTROLLER_BUILD"
grep -q "expertOpsRoutes" "$BUILD/src/core/app.ts" || fail "OPS_APP_MARKER"
grep -q "confirmOpsPayment" "$BUILD/src/modules/expert-ops/controllers/expert-ops.controller.ts" || fail "OPS_PAYMENT_MARKER"
grep -q "financialMutation:false" "$BUILD/src/modules/expert-ops/controllers/expert-ops.controller.ts" || fail "OPS_NO_LEDGER_MARKER"
echo "ISOLATED_TYPESCRIPT_BUILD=PASS"

echo "=== 3. BACKUP APP + EXPERT-OPS ONLY ==="
cp src/core/app.ts "$BACKUP/app.ts"
[ -f dist/core/app.js ] && cp dist/core/app.js "$BACKUP/app.host.js" || true
docker cp "$CONTAINER:/app/dist/core/app.js" "$BACKUP/app.container.js" >/dev/null
if [ -d src/modules/expert-ops ]; then tar -czf "$BACKUP/expert-ops-source.tgz" -C "$PROD_ROOT/src/modules" expert-ops; fi
if docker exec "$CONTAINER" test -d /app/dist/modules/expert-ops; then
  docker exec "$CONTAINER" sh -lc 'tar -czf /tmp/expert-ops-container.tgz -C /app/dist/modules expert-ops'
  docker cp "$CONTAINER:/tmp/expert-ops-container.tgz" "$BACKUP/expert-ops-container.tgz" >/dev/null
  docker exec "$CONTAINER" rm -f /tmp/expert-ops-container.tgz
fi
chmod 600 "$BACKUP"/*
echo "BACKUP=PASS"

trap 'echo "UNEXPECTED_ERROR_AFTER_INSTALL=YES"; rollback' ERR

echo "=== 4. SURGICAL INSTALL ==="
cp "$BUILD/src/core/app.ts" src/core/app.ts
rm -rf src/modules/expert-ops
mkdir -p src/modules/expert-ops
cp -a "$BUILD/src/modules/expert-ops/." src/modules/expert-ops/
[ -d dist/core ] && cp "$BUILD/dist/core/app.js" dist/core/app.js || true
rm -rf dist/modules/expert-ops
mkdir -p dist/modules/expert-ops
cp -a "$BUILD/dist/modules/expert-ops/." dist/modules/expert-ops/
docker exec "$CONTAINER" sh -lc 'rm -rf /app/dist/modules/expert-ops && mkdir -p /app/dist/modules/expert-ops'
docker cp "$BUILD/dist/core/app.js" "$CONTAINER:/app/dist/core/app.js" >/dev/null
docker cp "$BUILD/dist/modules/expert-ops/." "$CONTAINER:/app/dist/modules/expert-ops/" >/dev/null
echo "SURGICAL_INSTALL=PASS"

echo "=== 5. RESTART — NO RECREATE ==="
docker restart "$CONTAINER" >/dev/null
OK=0
for _ in $(seq 1 30); do
  if health >/tmp/expert-ops-health.json 2>/dev/null; then OK=1; cat /tmp/expert-ops-health.json; echo; break; fi
  sleep 1
done
if [ "$OK" -ne 1 ]; then echo "HEALTH_AFTER_DEPLOY=FAIL"; rollback; exit 1; fi
echo "HEALTH_AFTER_DEPLOY=PASS"

echo "=== 6. POST FINANCIAL GATES ==="
[ "$(sha256sum src/modules/payments/controllers/direct.controller.ts | awk '{print $1}')" = "$EXPECTED_DIRECT" ] || { rollback; exit 1; }
[ "$(sha256sum src/modules/payments/routes/payments.routes.ts | awk '{print $1}')" = "$EXPECTED_ROUTES" ] || { rollback; exit 1; }
[ "$(sha256sum src/modules/payments/controllers/stripe.webhook.ts | awk '{print $1}')" = "$EXPECTED_WEBHOOK" ] || { rollback; exit 1; }
docker exec "$CONTAINER" grep -q "STRIPE WEBHOOK SHARED VAULT RESOLVED" "$VERIFIER_DIST" || { rollback; exit 1; }
docker exec "$CONTAINER" grep -q "XPAY Sandbox" /app/dist/modules/auth/controllers/auth.controller.js || { rollback; exit 1; }
docker exec "$CONTAINER" test -s /app/dist/modules/expert/controllers/expert-payment-instructions.controller.js || { rollback; exit 1; }
echo "FINANCIAL_INVARIANTS_POST=PASS"
echo "SHARED_VAULT_POST=PASS"
echo "ONBOARDING_AUTH_POST=PASS"
echo "EXPERT_RUNTIME_POST=PASS"

echo "=== 7. EXPERT OPS AUTH GATE ==="
HTTP="$(curl -sS -o /tmp/expert-ops-noauth.json -w '%{http_code}' https://api.xpayments.digital/api/v1/expert-ops/me)"
echo "OPS_NOAUTH_HTTP=$HTTP"
[ "$HTTP" = "401" ] || { rollback; exit 1; }
echo "OPS_AUTH_GATE=PASS"

echo "=== 8. FINAL HEALTH ==="
rm -f /tmp/expert-ops-noauth.json /tmp/expert-ops-health.json
health; echo
echo "FINAL_HEALTH=PASS"
echo "EXPERT_OPS_RUNTIME_DEPLOY=PASS"
trap - ERR
