#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="/root/xpayments-backend-v3"
CONTAINER="xpayments-api-v3"
BRANCH="fix/checkout-signed-reconcile-20260907"
EXPECTED_DIRECT="f4ac2ee6f982ed98f59b90ce45ec6b12691ed31bd1e84472510cbec90e696b32"
EXPECTED_ROUTES="31efe0f9e5d87b3224c7fb55042b4ea8f79ddd3b43b61cce6b5bd910d28a37e5"
EXPECTED_WEBHOOK="968826914cf620126ebcb675939518aa2685bc45715e7c6e6aec3b619ec64bfa"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BUILD="/root/cp-profile-fix-build-${STAMP}"
BACKUP="/root/cp-profile-fix-backup-${STAMP}"

health(){ curl -fsS https://api.xpayments.digital/api/health; }
fail(){ echo "$1=FAIL"; exit 1; }

cd "$ROOT"
mkdir -p "$BUILD" "$BACKUP"

echo "======================================================"
echo " XPAYMENTS — PROCESSING PROFILE RUNTIME FIX"
echo "======================================================"

echo "=== 1. PRE HEALTH / FINANCIAL GATES ==="
health; echo
[ "$(sha256sum src/modules/payments/controllers/direct.controller.ts | awk '{print $1}')" = "$EXPECTED_DIRECT" ] || fail "DIRECT_PRE"
[ "$(sha256sum src/modules/payments/routes/payments.routes.ts | awk '{print $1}')" = "$EXPECTED_ROUTES" ] || fail "PAYMENTS_ROUTES_PRE"
[ "$(sha256sum src/modules/payments/controllers/stripe.webhook.ts | awk '{print $1}')" = "$EXPECTED_WEBHOOK" ] || fail "WEBHOOK_PRE"
VERIFIER_DIST="$(docker exec "$CONTAINER" sh -lc "find /app/dist -type f -name 'stripe-webhook-verification.service.js' -print -quit")"
[ -n "$VERIFIER_DIST" ] || fail "VERIFIER_FOUND"
docker exec "$CONTAINER" grep -q "STRIPE WEBHOOK SHARED VAULT RESOLVED" "$VERIFIER_DIST" || fail "SHARED_VAULT_PRE"
echo "FINANCIAL_INVARIANTS_PRE=PASS"
echo "SHARED_VAULT_PRE=PASS"

echo "=== 2. ISOLATED BUILD ==="
git fetch origin "$BRANCH" >/dev/null 2>&1
TARGET_COMMIT="$(git rev-parse "origin/$BRANCH")"
echo "TARGET_COMMIT=$TARGET_COMMIT"
git archive "$TARGET_COMMIT" | tar -x -C "$BUILD"
ln -s "$ROOT/node_modules" "$BUILD/node_modules"
(
  cd "$BUILD"
  "$ROOT/node_modules/.bin/tsc" -p tsconfig.json
)
[ -s "$BUILD/dist/modules/control-plane/controllers/control-plane-processing-profile.controller.js" ] || fail "PROFILE_HANDLER_BUILD"
[ -s "$BUILD/dist/modules/control-plane/routes/control-plane.routes.js" ] || fail "CONTROL_PLANE_ROUTES_BUILD"
grep -q "V1.*VNEXT\|raw === 'V1'" "$BUILD/src/modules/control-plane/controllers/control-plane-processing-profile.controller.ts" || fail "V1_NORMALIZATION_GATE"
grep -q "RUNTIME_GENERATION_INVALID" "$BUILD/src/modules/control-plane/controllers/control-plane-processing-profile.controller.ts" || fail "RUNTIME_VALIDATION_GATE"
grep -q "upsertProcessingProfileSafe" "$BUILD/src/modules/control-plane/routes/control-plane.routes.ts" || fail "SAFE_ROUTE_GATE"
echo "ISOLATED_TYPESCRIPT_BUILD=PASS"
echo "PROCESSING_PROFILE_SOURCE_GATES=PASS"

echo "=== 3. BACKUP TARGET FILES ONLY ==="
cp src/modules/control-plane/routes/control-plane.routes.ts "$BACKUP/control-plane.routes.ts"
cp dist/modules/control-plane/routes/control-plane.routes.js "$BACKUP/control-plane.routes.host.js"
docker cp "$CONTAINER:/app/dist/modules/control-plane/routes/control-plane.routes.js" "$BACKUP/control-plane.routes.container.js" >/dev/null
if [ -f src/modules/control-plane/controllers/control-plane-processing-profile.controller.ts ]; then cp src/modules/control-plane/controllers/control-plane-processing-profile.controller.ts "$BACKUP/profile.controller.ts"; fi
if [ -f dist/modules/control-plane/controllers/control-plane-processing-profile.controller.js ]; then cp dist/modules/control-plane/controllers/control-plane-processing-profile.controller.js "$BACKUP/profile.controller.host.js"; fi
if docker exec "$CONTAINER" test -f /app/dist/modules/control-plane/controllers/control-plane-processing-profile.controller.js; then docker cp "$CONTAINER:/app/dist/modules/control-plane/controllers/control-plane-processing-profile.controller.js" "$BACKUP/profile.controller.container.js" >/dev/null; fi
chmod 600 "$BACKUP"/* 2>/dev/null || true
echo "BACKUP=PASS"

rollback(){
  trap - ERR
  set +e
  echo "ROLLBACK_START=YES"
  cp "$BACKUP/control-plane.routes.ts" src/modules/control-plane/routes/control-plane.routes.ts
  cp "$BACKUP/control-plane.routes.host.js" dist/modules/control-plane/routes/control-plane.routes.js
  docker cp "$BACKUP/control-plane.routes.container.js" "$CONTAINER:/app/dist/modules/control-plane/routes/control-plane.routes.js" >/dev/null 2>&1
  if [ -f "$BACKUP/profile.controller.ts" ]; then cp "$BACKUP/profile.controller.ts" src/modules/control-plane/controllers/control-plane-processing-profile.controller.ts; else rm -f src/modules/control-plane/controllers/control-plane-processing-profile.controller.ts; fi
  if [ -f "$BACKUP/profile.controller.host.js" ]; then cp "$BACKUP/profile.controller.host.js" dist/modules/control-plane/controllers/control-plane-processing-profile.controller.js; else rm -f dist/modules/control-plane/controllers/control-plane-processing-profile.controller.js; fi
  if [ -f "$BACKUP/profile.controller.container.js" ]; then docker cp "$BACKUP/profile.controller.container.js" "$CONTAINER:/app/dist/modules/control-plane/controllers/control-plane-processing-profile.controller.js" >/dev/null 2>&1; else docker exec "$CONTAINER" rm -f /app/dist/modules/control-plane/controllers/control-plane-processing-profile.controller.js >/dev/null 2>&1; fi
  docker restart "$CONTAINER" >/dev/null 2>&1
  sleep 3
  health || true
  echo
  echo "ROLLBACK_COMPLETE=YES"
}
trap 'echo "UNEXPECTED_ERROR_AFTER_INSTALL=YES"; rollback' ERR

echo "=== 4. SURGICAL INSTALL ==="
cp "$BUILD/src/modules/control-plane/routes/control-plane.routes.ts" src/modules/control-plane/routes/control-plane.routes.ts
cp "$BUILD/src/modules/control-plane/controllers/control-plane-processing-profile.controller.ts" src/modules/control-plane/controllers/control-plane-processing-profile.controller.ts
cp "$BUILD/dist/modules/control-plane/routes/control-plane.routes.js" dist/modules/control-plane/routes/control-plane.routes.js
cp "$BUILD/dist/modules/control-plane/controllers/control-plane-processing-profile.controller.js" dist/modules/control-plane/controllers/control-plane-processing-profile.controller.js
docker cp "$BUILD/dist/modules/control-plane/routes/control-plane.routes.js" "$CONTAINER:/app/dist/modules/control-plane/routes/control-plane.routes.js" >/dev/null
docker cp "$BUILD/dist/modules/control-plane/controllers/control-plane-processing-profile.controller.js" "$CONTAINER:/app/dist/modules/control-plane/controllers/control-plane-processing-profile.controller.js" >/dev/null
echo "SURGICAL_INSTALL=PASS"

echo "=== 5. RESTART — NO RECREATE ==="
docker restart "$CONTAINER" >/dev/null
OK=0
for _ in $(seq 1 30); do
  if health >/tmp/cp-profile-fix-health.json 2>/dev/null; then OK=1; cat /tmp/cp-profile-fix-health.json; echo; break; fi
  sleep 1
done
if [ "$OK" -ne 1 ]; then echo "HEALTH_AFTER_FIX=FAIL"; rollback; exit 1; fi
echo "HEALTH_AFTER_FIX=PASS"

echo "=== 6. POST GATES ==="
[ "$(sha256sum src/modules/payments/controllers/direct.controller.ts | awk '{print $1}')" = "$EXPECTED_DIRECT" ] || { rollback; exit 1; }
[ "$(sha256sum src/modules/payments/routes/payments.routes.ts | awk '{print $1}')" = "$EXPECTED_ROUTES" ] || { rollback; exit 1; }
[ "$(sha256sum src/modules/payments/controllers/stripe.webhook.ts | awk '{print $1}')" = "$EXPECTED_WEBHOOK" ] || { rollback; exit 1; }
docker exec "$CONTAINER" grep -q "STRIPE WEBHOOK SHARED VAULT RESOLVED" "$VERIFIER_DIST" || { rollback; exit 1; }
docker exec "$CONTAINER" grep -q "RUNTIME_GENERATION_INVALID" /app/dist/modules/control-plane/controllers/control-plane-processing-profile.controller.js || { rollback; exit 1; }
docker exec "$CONTAINER" grep -q "upsertProcessingProfileSafe" /app/dist/modules/control-plane/routes/control-plane.routes.js || { rollback; exit 1; }
NOAUTH_HTTP="$(curl -sS -o /tmp/cp-profile-noauth.json -w '%{http_code}' -X PUT https://api.xpayments.digital/api/v1/control-plane/stores/00000000-0000-0000-0000-000000000000/processing-profile -H 'Content-Type: application/json' --data '{"runtimeGeneration":"V1"}')"
echo "PROCESSING_PROFILE_NOAUTH_HTTP=$NOAUTH_HTTP"
[ "$NOAUTH_HTTP" = "401" ] || { rollback; exit 1; }
echo "FINANCIAL_INVARIANTS_POST=PASS"
echo "SHARED_VAULT_POST=PASS"
echo "PROCESSING_PROFILE_RUNTIME_FIX=PASS"
echo "PROVIDER_CALLED=NO"
echo "FINANCIAL_MUTATION=NO"

rm -f /tmp/cp-profile-fix-health.json /tmp/cp-profile-noauth.json
health; echo
echo "FINAL_HEALTH=PASS"
trap - ERR
