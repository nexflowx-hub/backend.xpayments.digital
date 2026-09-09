#!/usr/bin/env bash
set -Eeuo pipefail

PROD_ROOT="/root/xpayments-backend-v3"
CONTAINER="xpayments-api-v3"
BRANCH="fix/checkout-signed-reconcile-20260907"
EXPECTED_DIRECT="f4ac2ee6f982ed98f59b90ce45ec6b12691ed31bd1e84472510cbec90e696b32"
EXPECTED_ROUTES="31efe0f9e5d87b3224c7fb55042b4ea8f79ddd3b43b61cce6b5bd910d28a37e5"
EXPECTED_WEBHOOK="968826914cf620126ebcb675939518aa2685bc45715e7c6e6aec3b619ec64bfa"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BUILD="/root/xpay-expert-build-${STAMP}"
BACKUP="/root/xpay-expert-backup-${STAMP}"
APP_SRC="src/core/app.ts"
APP_DIST="/app/dist/core/app.js"
EXPERT_SRC="src/modules/expert"
EXPERT_DIST="/app/dist/modules/expert"

health(){ curl -fsS https://api.xpayments.digital/api/health; }
fail(){ echo "$1=FAIL"; exit 1; }

rollback(){
  trap - ERR
  set +e
  echo "ROLLBACK_START=YES"
  [ -f "$BACKUP/app.ts" ] && cp "$BACKUP/app.ts" "$PROD_ROOT/$APP_SRC"
  [ -f "$BACKUP/app.host.js" ] && cp "$BACKUP/app.host.js" "$PROD_ROOT/dist/core/app.js"
  [ -f "$BACKUP/app.container.js" ] && docker cp "$BACKUP/app.container.js" "$CONTAINER:$APP_DIST" >/dev/null 2>&1
  if [ -f "$BACKUP/expert-source.tgz" ]; then
    rm -rf "$PROD_ROOT/$EXPERT_SRC"
    mkdir -p "$PROD_ROOT/src/modules"
    tar -xzf "$BACKUP/expert-source.tgz" -C "$PROD_ROOT/src/modules"
  else
    rm -rf "$PROD_ROOT/$EXPERT_SRC"
  fi
  if [ -f "$BACKUP/expert-container.tgz" ]; then
    docker exec "$CONTAINER" sh -lc 'rm -rf /app/dist/modules/expert && mkdir -p /app/dist/modules'
    docker cp "$BACKUP/expert-container.tgz" "$CONTAINER:/tmp/expert-container.tgz" >/dev/null 2>&1
    docker exec "$CONTAINER" sh -lc 'tar -xzf /tmp/expert-container.tgz -C /app/dist/modules && rm -f /tmp/expert-container.tgz'
  else
    docker exec "$CONTAINER" sh -lc 'rm -rf /app/dist/modules/expert'
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
echo " XPAYMENTS — XPAY.EXPERT RUNTIME DEPLOY V2"
echo "======================================================"

echo "=== 1. PRE HEALTH / PAYMENT GATES ==="
health; echo
[ "$(sha256sum src/modules/payments/controllers/direct.controller.ts | awk '{print $1}')" = "$EXPECTED_DIRECT" ] || fail "DIRECT_PRE"
[ "$(sha256sum src/modules/payments/routes/payments.routes.ts | awk '{print $1}')" = "$EXPECTED_ROUTES" ] || fail "ROUTES_PRE"
[ "$(sha256sum src/modules/payments/controllers/stripe.webhook.ts | awk '{print $1}')" = "$EXPECTED_WEBHOOK" ] || fail "WEBHOOK_PRE"
VERIFIER_DIST="$(docker exec "$CONTAINER" sh -lc "find /app/dist -type f -name 'stripe-webhook-verification.service.js' -print -quit")"
[ -n "$VERIFIER_DIST" ] || fail "VERIFIER_FOUND"
docker exec "$CONTAINER" grep -q "STRIPE WEBHOOK SHARED VAULT RESOLVED" "$VERIFIER_DIST" || fail "SHARED_VAULT_PRE"
docker exec "$CONTAINER" grep -q "XPAY Sandbox" /app/dist/modules/auth/controllers/auth.controller.js || fail "ONBOARDING_AUTH_PRE"
echo "PAYMENT_INVARIANTS_PRE=PASS"
echo "SHARED_VAULT_PRE=PASS"
echo "ONBOARDING_AUTH_PRE=PASS"

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
[ -s "$BUILD/dist/modules/expert/routes/expert.routes.js" ] || fail "EXPERT_PRIVATE_BUILD"
[ -s "$BUILD/dist/modules/expert/routes/expert.public.routes.js" ] || fail "EXPERT_PUBLIC_BUILD"
[ -s "$BUILD/dist/modules/expert/controllers/expert-orders.controller.js" ] || fail "EXPERT_CONTROLLER_BUILD"
grep -q "expertPublicRoutes" "$BUILD/$APP_SRC" || fail "PUBLIC_ROUTE_MARKER"
grep -q "api.use('/expert', expertRoutes)" "$BUILD/$APP_SRC" || fail "PRIVATE_ROUTE_MARKER"
echo "ISOLATED_TYPESCRIPT_BUILD=PASS"

echo "=== 3. BACKUP APP + EXPERT ONLY ==="
cp "$APP_SRC" "$BACKUP/app.ts"
[ -f dist/core/app.js ] && cp dist/core/app.js "$BACKUP/app.host.js" || true
docker cp "$CONTAINER:$APP_DIST" "$BACKUP/app.container.js" >/dev/null
if [ -d "$EXPERT_SRC" ]; then tar -czf "$BACKUP/expert-source.tgz" -C "$PROD_ROOT/src/modules" expert; fi
if docker exec "$CONTAINER" test -d "$EXPERT_DIST"; then
  docker exec "$CONTAINER" sh -lc 'tar -czf /tmp/expert-container.tgz -C /app/dist/modules expert'
  docker cp "$CONTAINER:/tmp/expert-container.tgz" "$BACKUP/expert-container.tgz" >/dev/null
  docker exec "$CONTAINER" rm -f /tmp/expert-container.tgz
fi
chmod 600 "$BACKUP"/*
echo "BACKUP=PASS"

trap 'echo "UNEXPECTED_ERROR_AFTER_INSTALL=YES"; rollback' ERR

echo "=== 4. SURGICAL INSTALL ==="
cp "$BUILD/$APP_SRC" "$APP_SRC"
rm -rf "$EXPERT_SRC"
mkdir -p "$EXPERT_SRC"
cp -a "$BUILD/$EXPERT_SRC/." "$EXPERT_SRC/"
[ -d dist/core ] && cp "$BUILD/dist/core/app.js" dist/core/app.js || true
rm -rf dist/modules/expert
mkdir -p dist/modules/expert
cp -a "$BUILD/dist/modules/expert/." dist/modules/expert/
docker exec "$CONTAINER" sh -lc 'rm -rf /app/dist/modules/expert && mkdir -p /app/dist/modules/expert'
docker cp "$BUILD/dist/core/app.js" "$CONTAINER:$APP_DIST" >/dev/null
docker cp "$BUILD/dist/modules/expert/." "$CONTAINER:$EXPERT_DIST/" >/dev/null
echo "SURGICAL_INSTALL=PASS"

echo "=== 5. RESTART — NO RECREATE ==="
docker restart "$CONTAINER" >/dev/null
OK=0
for _ in $(seq 1 30); do
  if health >/tmp/xpay-expert-health.json 2>/dev/null; then OK=1; cat /tmp/xpay-expert-health.json; echo; break; fi
  sleep 1
done
if [ "$OK" -ne 1 ]; then echo "HEALTH_AFTER_DEPLOY=FAIL"; rollback; exit 1; fi
echo "HEALTH_AFTER_DEPLOY=PASS"

echo "=== 6. POST PAYMENT GATES ==="
[ "$(sha256sum src/modules/payments/controllers/direct.controller.ts | awk '{print $1}')" = "$EXPECTED_DIRECT" ] || { rollback; exit 1; }
[ "$(sha256sum src/modules/payments/routes/payments.routes.ts | awk '{print $1}')" = "$EXPECTED_ROUTES" ] || { rollback; exit 1; }
[ "$(sha256sum src/modules/payments/controllers/stripe.webhook.ts | awk '{print $1}')" = "$EXPECTED_WEBHOOK" ] || { rollback; exit 1; }
docker exec "$CONTAINER" grep -q "STRIPE WEBHOOK SHARED VAULT RESOLVED" "$VERIFIER_DIST" || { rollback; exit 1; }
docker exec "$CONTAINER" grep -q "XPAY Sandbox" /app/dist/modules/auth/controllers/auth.controller.js || { rollback; exit 1; }
echo "PAYMENT_INVARIANTS_POST=PASS"
echo "SHARED_VAULT_POST=PASS"
echo "ONBOARDING_AUTH_POST=PASS"

echo "=== 7. PUBLIC CATALOG E2E ==="
CAT_HTTP="$(curl -sS -o /tmp/xpay-expert-offerings.json -w '%{http_code}' https://api.xpayments.digital/api/v1/expert/offerings)"
echo "CATALOG_HTTP=$CAT_HTTP"
[ "$CAT_HTTP" = "200" ] || { rollback; exit 1; }
python3 - <<'PY'
import json
p=json.load(open('/tmp/xpay-expert-offerings.json'))
rows=(p.get('data') or {}).get('offerings') or []
print('CATALOG_COUNT='+str(len(rows)))
print('CATALOG_CODES='+','.join(str(r.get('code')) for r in rows))
if len(rows) < 4: raise SystemExit(2)
PY
echo "PUBLIC_CATALOG_E2E=PASS"

echo "=== 8. PRIVATE ROUTE AUTH GATE ==="
ORDERS_HTTP="$(curl -sS -o /tmp/xpay-expert-orders-noauth.json -w '%{http_code}' https://api.xpayments.digital/api/v1/expert/orders)"
echo "ORDERS_NOAUTH_HTTP=$ORDERS_HTTP"
[ "$ORDERS_HTTP" = "401" ] || { rollback; exit 1; }
echo "PRIVATE_AUTH_GATE=PASS"

rm -f /tmp/xpay-expert-offerings.json /tmp/xpay-expert-orders-noauth.json

echo "=== 9. FINAL HEALTH ==="
health; echo
echo "FINAL_HEALTH=PASS"
echo "XPAY_EXPERT_RUNTIME_DEPLOY=PASS"
trap - ERR
