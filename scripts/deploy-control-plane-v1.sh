#!/usr/bin/env bash
set -Eeuo pipefail

PROD_ROOT="/root/xpayments-backend-v3"
CONTAINER="xpayments-api-v3"
BRANCH="fix/checkout-signed-reconcile-20260907"
EXPECTED_DIRECT="f4ac2ee6f982ed98f59b90ce45ec6b12691ed31bd1e84472510cbec90e696b32"
EXPECTED_ROUTES="31efe0f9e5d87b3224c7fb55042b4ea8f79ddd3b43b61cce6b5bd910d28a37e5"
EXPECTED_WEBHOOK="968826914cf620126ebcb675939518aa2685bc45715e7c6e6aec3b619ec64bfa"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BUILD="/root/control-plane-build-${STAMP}"
BACKUP="/root/control-plane-backup-${STAMP}"

health(){ curl -fsS https://api.xpayments.digital/api/health; }
fail(){ echo "$1=FAIL"; exit 1; }

rollback(){
  trap - ERR
  set +e
  echo "ROLLBACK_START=YES"

  [ -f "$BACKUP/app.ts" ] && cp "$BACKUP/app.ts" "$PROD_ROOT/src/core/app.ts"
  [ -f "$BACKUP/app.host.js" ] && cp "$BACKUP/app.host.js" "$PROD_ROOT/dist/core/app.js"
  [ -f "$BACKUP/app.container.js" ] && docker cp "$BACKUP/app.container.js" "$CONTAINER:/app/dist/core/app.js" >/dev/null 2>&1

  [ -f "$BACKUP/gateway.controller.ts" ] && cp "$BACKUP/gateway.controller.ts" "$PROD_ROOT/src/modules/gateway/controllers/gateway.controller.ts"
  [ -f "$BACKUP/gateway.controller.host.js" ] && cp "$BACKUP/gateway.controller.host.js" "$PROD_ROOT/dist/modules/gateway/controllers/gateway.controller.js"
  [ -f "$BACKUP/gateway.controller.container.js" ] && docker cp "$BACKUP/gateway.controller.container.js" "$CONTAINER:/app/dist/modules/gateway/controllers/gateway.controller.js" >/dev/null 2>&1

  if [ -f "$BACKUP/control-plane-source.tgz" ]; then
    rm -rf "$PROD_ROOT/src/modules/control-plane"
    tar -xzf "$BACKUP/control-plane-source.tgz" -C "$PROD_ROOT/src/modules"
  else
    rm -rf "$PROD_ROOT/src/modules/control-plane"
  fi

  if [ -f "$BACKUP/control-plane-host.tgz" ]; then
    rm -rf "$PROD_ROOT/dist/modules/control-plane"
    tar -xzf "$BACKUP/control-plane-host.tgz" -C "$PROD_ROOT/dist/modules"
  else
    rm -rf "$PROD_ROOT/dist/modules/control-plane"
  fi

  if [ -f "$BACKUP/control-plane-container.tgz" ]; then
    docker exec "$CONTAINER" sh -lc 'rm -rf /app/dist/modules/control-plane && mkdir -p /app/dist/modules'
    docker cp "$BACKUP/control-plane-container.tgz" "$CONTAINER:/tmp/control-plane-container.tgz" >/dev/null 2>&1
    docker exec "$CONTAINER" sh -lc 'tar -xzf /tmp/control-plane-container.tgz -C /app/dist/modules && rm -f /tmp/control-plane-container.tgz'
  else
    docker exec "$CONTAINER" sh -lc 'rm -rf /app/dist/modules/control-plane'
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
echo " XPAYMENTS — CONTROL PLANE V1 RUNTIME DEPLOY"
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
docker exec "$CONTAINER" test -s /app/dist/modules/expert-ops/controllers/expert-ops.controller.js || fail "EXPERT_OPS_RUNTIME_PRE"
echo "FINANCIAL_INVARIANTS_PRE=PASS"
echo "SHARED_VAULT_PRE=PASS"
echo "ONBOARDING_AUTH_PRE=PASS"
echo "EXPERT_RUNTIME_PRE=PASS"
echo "EXPERT_OPS_RUNTIME_PRE=PASS"

echo "=== 2. GATEWAY PRE-STATE ==="
grep -q "data: req.body" src/modules/gateway/controllers/gateway.controller.ts || fail "GATEWAY_PRE_EXPECTED_STATE"
echo "GATEWAY_PRE_EXPECTED_STATE=PASS"

echo "=== 3. ISOLATED BUILD ==="
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
[ -s "$BUILD/dist/modules/control-plane/routes/control-plane.routes.js" ] || fail "CONTROL_PLANE_ROUTE_BUILD"
[ -s "$BUILD/dist/modules/control-plane/controllers/control-plane-auth.controller.js" ] || fail "CONTROL_PLANE_AUTH_BUILD"
[ -s "$BUILD/dist/modules/control-plane/controllers/control-plane-read.controller.js" ] || fail "CONTROL_PLANE_READ_BUILD"
[ -s "$BUILD/dist/modules/gateway/controllers/gateway.controller.js" ] || fail "GATEWAY_BUILD"
grep -q "controlPlanePublicRoutes" "$BUILD/src/core/app.ts" || fail "CONTROL_PLANE_APP_MARKER"
grep -q "control_plane_sessions" "$BUILD/src/modules/control-plane/middleware/control-plane-auth.middleware.ts" || fail "CONTROL_PLANE_SESSION_MARKER"
grep -q "credentialsRedacted:true" "$BUILD/src/modules/control-plane/controllers/control-plane-filtered.controller.ts" || fail "VAULT_REDACTION_MARKER"
grep -q "findOwnedStore" "$BUILD/src/modules/gateway/controllers/gateway.controller.ts" || fail "GATEWAY_OWNERSHIP_MARKER"
! grep -q "data: req.body" "$BUILD/src/modules/gateway/controllers/gateway.controller.ts" || fail "GATEWAY_WHITELIST_MARKER"
echo "ISOLATED_TYPESCRIPT_BUILD=PASS"
echo "CONTROL_PLANE_SOURCE_GATES=PASS"
echo "GATEWAY_HARDENING_GATES=PASS"

echo "=== 4. BACKUP APP + CONTROL-PLANE + GATEWAY ONLY ==="
cp src/core/app.ts "$BACKUP/app.ts"
[ -f dist/core/app.js ] && cp dist/core/app.js "$BACKUP/app.host.js" || true
docker cp "$CONTAINER:/app/dist/core/app.js" "$BACKUP/app.container.js" >/dev/null

cp src/modules/gateway/controllers/gateway.controller.ts "$BACKUP/gateway.controller.ts"
[ -f dist/modules/gateway/controllers/gateway.controller.js ] && cp dist/modules/gateway/controllers/gateway.controller.js "$BACKUP/gateway.controller.host.js" || true
docker cp "$CONTAINER:/app/dist/modules/gateway/controllers/gateway.controller.js" "$BACKUP/gateway.controller.container.js" >/dev/null

if [ -d src/modules/control-plane ]; then tar -czf "$BACKUP/control-plane-source.tgz" -C "$PROD_ROOT/src/modules" control-plane; fi
if [ -d dist/modules/control-plane ]; then tar -czf "$BACKUP/control-plane-host.tgz" -C "$PROD_ROOT/dist/modules" control-plane; fi
if docker exec "$CONTAINER" test -d /app/dist/modules/control-plane; then
  docker exec "$CONTAINER" sh -lc 'tar -czf /tmp/control-plane-container.tgz -C /app/dist/modules control-plane'
  docker cp "$CONTAINER:/tmp/control-plane-container.tgz" "$BACKUP/control-plane-container.tgz" >/dev/null
  docker exec "$CONTAINER" rm -f /tmp/control-plane-container.tgz
fi
chmod 600 "$BACKUP"/*
echo "BACKUP=PASS"

trap 'echo "UNEXPECTED_ERROR_AFTER_INSTALL=YES"; rollback' ERR

echo "=== 5. SURGICAL INSTALL ==="
cp "$BUILD/src/core/app.ts" src/core/app.ts
cp "$BUILD/dist/core/app.js" dist/core/app.js

a="src/modules/control-plane"; rm -rf "$a"; mkdir -p "$a"; cp -a "$BUILD/src/modules/control-plane/." "$a/"
a="dist/modules/control-plane"; rm -rf "$a"; mkdir -p "$a"; cp -a "$BUILD/dist/modules/control-plane/." "$a/"

cp "$BUILD/src/modules/gateway/controllers/gateway.controller.ts" src/modules/gateway/controllers/gateway.controller.ts
cp "$BUILD/dist/modules/gateway/controllers/gateway.controller.js" dist/modules/gateway/controllers/gateway.controller.js

docker cp "$BUILD/dist/core/app.js" "$CONTAINER:/app/dist/core/app.js" >/dev/null
docker exec "$CONTAINER" sh -lc 'rm -rf /app/dist/modules/control-plane && mkdir -p /app/dist/modules/control-plane'
docker cp "$BUILD/dist/modules/control-plane/." "$CONTAINER:/app/dist/modules/control-plane/" >/dev/null
docker cp "$BUILD/dist/modules/gateway/controllers/gateway.controller.js" "$CONTAINER:/app/dist/modules/gateway/controllers/gateway.controller.js" >/dev/null

echo "SURGICAL_INSTALL=PASS"

echo "=== 6. RESTART — NO RECREATE ==="
docker restart "$CONTAINER" >/dev/null
OK=0
for _ in $(seq 1 30); do
  if health >/tmp/control-plane-health.json 2>/dev/null; then OK=1; cat /tmp/control-plane-health.json; echo; break; fi
  sleep 1
done
if [ "$OK" -ne 1 ]; then echo "HEALTH_AFTER_DEPLOY=FAIL"; rollback; exit 1; fi
echo "HEALTH_AFTER_DEPLOY=PASS"

echo "=== 7. POST FINANCIAL GATES ==="
[ "$(sha256sum src/modules/payments/controllers/direct.controller.ts | awk '{print $1}')" = "$EXPECTED_DIRECT" ] || { rollback; exit 1; }
[ "$(sha256sum src/modules/payments/routes/payments.routes.ts | awk '{print $1}')" = "$EXPECTED_ROUTES" ] || { rollback; exit 1; }
[ "$(sha256sum src/modules/payments/controllers/stripe.webhook.ts | awk '{print $1}')" = "$EXPECTED_WEBHOOK" ] || { rollback; exit 1; }
docker exec "$CONTAINER" grep -q "STRIPE WEBHOOK SHARED VAULT RESOLVED" "$VERIFIER_DIST" || { rollback; exit 1; }
docker exec "$CONTAINER" grep -q "XPAY Sandbox" /app/dist/modules/auth/controllers/auth.controller.js || { rollback; exit 1; }
docker exec "$CONTAINER" test -s /app/dist/modules/expert/controllers/expert-payment-instructions.controller.js || { rollback; exit 1; }
docker exec "$CONTAINER" test -s /app/dist/modules/expert-ops/controllers/expert-ops.controller.js || { rollback; exit 1; }
echo "FINANCIAL_INVARIANTS_POST=PASS"
echo "SHARED_VAULT_POST=PASS"
echo "ONBOARDING_AUTH_POST=PASS"
echo "EXPERT_RUNTIME_POST=PASS"
echo "EXPERT_OPS_RUNTIME_POST=PASS"

echo "=== 8. CONTROL PLANE AUTH GATES ==="
ME_HTTP="$(curl -sS -o /tmp/control-plane-me.json -w '%{http_code}' https://api.xpayments.digital/api/v1/control-plane/me)"
echo "CONTROL_PLANE_ME_NOAUTH_HTTP=$ME_HTTP"
[ "$ME_HTTP" = "401" ] || { rollback; exit 1; }
LOGIN_HTTP="$(curl -sS -o /tmp/control-plane-login.json -w '%{http_code}' -X POST https://api.xpayments.digital/api/v1/control-plane/auth/login -H 'Content-Type: application/json' --data '{}')"
echo "CONTROL_PLANE_EMPTY_LOGIN_HTTP=$LOGIN_HTTP"
[ "$LOGIN_HTTP" = "400" ] || { rollback; exit 1; }
echo "CONTROL_PLANE_AUTH_GATES=PASS"

echo "=== 9. CONTROL PLANE DB READ GATE ==="
docker exec "$CONTAINER" node - <<'NODE'
const pm=require('/app/dist/core/prisma');
const p=pm.default||pm;
(async()=>{
  const rows=await p.$queryRawUnsafe(`
    select
      (select count(*)::int from control_plane_users) as users,
      (select count(*)::int from control_plane_sessions) as sessions,
      (select count(*)::int from control_plane_audit_logs) as audit_logs,
      (select count(*)::int from control_plane_action_approvals) as approvals
  `);
  console.log('CONTROL_PLANE_TABLES=PASS');
  console.log('CONTROL_PLANE_USERS='+Number(rows[0]?.users||0));
  console.log('CONTROL_PLANE_SESSIONS='+Number(rows[0]?.sessions||0));
})().catch(e=>{console.error(e.message||e);process.exitCode=1}).finally(()=>p.$disconnect());
NODE
echo "CONTROL_PLANE_DB_READ_GATE=PASS"

echo "=== 10. GATEWAY HARDENING POST GATE ==="
grep -q "findOwnedStore" src/modules/gateway/controllers/gateway.controller.ts || { rollback; exit 1; }
! grep -q "data: req.body" src/modules/gateway/controllers/gateway.controller.ts || { rollback; exit 1; }
GATEWAY_NOAUTH_HTTP="$(curl -sS -o /tmp/gateway-noauth.json -w '%{http_code}' https://api.xpayments.digital/api/v1/gateway-vault)"
echo "GATEWAY_NOAUTH_HTTP=$GATEWAY_NOAUTH_HTTP"
[ "$GATEWAY_NOAUTH_HTTP" = "401" ] || { rollback; exit 1; }
echo "GATEWAY_HARDENING_POST=PASS"

echo "=== 11. FINAL HEALTH ==="
rm -f /tmp/control-plane-health.json /tmp/control-plane-me.json /tmp/control-plane-login.json /tmp/gateway-noauth.json
health; echo
echo "FINAL_HEALTH=PASS"
echo "CONTROL_PLANE_RUNTIME_DEPLOY=PASS"
trap - ERR
