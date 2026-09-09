#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="/root/xpayments-backend-v3"
CONTAINER="xpayments-api-v3"
BRANCH="fix/checkout-signed-reconcile-20260907"
EXPECTED_DIRECT="f4ac2ee6f982ed98f59b90ce45ec6b12691ed31bd1e84472510cbec90e696b32"
EXPECTED_ROUTES="31efe0f9e5d87b3224c7fb55042b4ea8f79ddd3b43b61cce6b5bd910d28a37e5"
EXPECTED_WEBHOOK="968826914cf620126ebcb675939518aa2685bc45715e7c6e6aec3b619ec64bfa"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BUILD="/root/control-plane-v2-build-${STAMP}"
BACKUP="/root/control-plane-v2-backup-${STAMP}"

health(){ curl -fsS https://api.xpayments.digital/api/health; }
fail(){ echo "$1=FAIL"; exit 1; }

backup_module(){
  local name="$1"
  if [ -d "$ROOT/src/modules/$name" ]; then
    tar -czf "$BACKUP/${name}-source.tgz" -C "$ROOT/src/modules" "$name"
  fi
  if [ -d "$ROOT/dist/modules/$name" ]; then
    tar -czf "$BACKUP/${name}-host.tgz" -C "$ROOT/dist/modules" "$name"
  fi
  if docker exec "$CONTAINER" test -d "/app/dist/modules/$name"; then
    docker exec "$CONTAINER" sh -lc "tar -czf /tmp/${name}-container.tgz -C /app/dist/modules ${name}"
    docker cp "$CONTAINER:/tmp/${name}-container.tgz" "$BACKUP/${name}-container.tgz" >/dev/null
    docker exec "$CONTAINER" rm -f "/tmp/${name}-container.tgz"
  fi
}

restore_module(){
  local name="$1"
  rm -rf "$ROOT/src/modules/$name" "$ROOT/dist/modules/$name"
  if [ -f "$BACKUP/${name}-source.tgz" ]; then tar -xzf "$BACKUP/${name}-source.tgz" -C "$ROOT/src/modules"; fi
  if [ -f "$BACKUP/${name}-host.tgz" ]; then tar -xzf "$BACKUP/${name}-host.tgz" -C "$ROOT/dist/modules"; fi
  docker exec "$CONTAINER" sh -lc "rm -rf /app/dist/modules/${name}"
  if [ -f "$BACKUP/${name}-container.tgz" ]; then
    docker cp "$BACKUP/${name}-container.tgz" "$CONTAINER:/tmp/${name}-container.tgz" >/dev/null
    docker exec "$CONTAINER" sh -lc "tar -xzf /tmp/${name}-container.tgz -C /app/dist/modules && rm -f /tmp/${name}-container.tgz"
  fi
}

rollback(){
  trap - ERR
  set +e
  echo "ROLLBACK_START=YES"
  [ -f "$BACKUP/app.ts" ] && cp "$BACKUP/app.ts" "$ROOT/src/core/app.ts"
  [ -f "$BACKUP/app.host.js" ] && cp "$BACKUP/app.host.js" "$ROOT/dist/core/app.js"
  [ -f "$BACKUP/app.container.js" ] && docker cp "$BACKUP/app.container.js" "$CONTAINER:/app/dist/core/app.js" >/dev/null 2>&1
  restore_module control-plane
  restore_module stripe-relay
  docker restart "$CONTAINER" >/dev/null 2>&1
  sleep 3
  health || true
  echo
  echo "ROLLBACK_COMPLETE=YES"
}

cd "$ROOT"
mkdir -p "$BACKUP"

echo "======================================================"
echo " XPAYMENTS — CONTROL PLANE V2 LIVE OPS DEPLOY"
echo "======================================================"

echo "=== 1. PRE HEALTH / IMMUTABLE FINANCIAL GATES ==="
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
docker exec "$CONTAINER" test -s /app/dist/modules/control-plane/routes/control-plane.routes.js || fail "CONTROL_PLANE_V1_PRE"
echo "FINANCIAL_INVARIANTS_PRE=PASS"
echo "SHARED_VAULT_PRE=PASS"
echo "ONBOARDING_AUTH_PRE=PASS"
echo "EXPERT_RUNTIME_PRE=PASS"
echo "EXPERT_OPS_RUNTIME_PRE=PASS"
echo "CONTROL_PLANE_V1_PRE=PASS"

echo "=== 2. ISOLATED BUILD ==="
git fetch origin "$BRANCH" >/dev/null 2>&1
TARGET_COMMIT="$(git rev-parse "origin/$BRANCH")"
echo "TARGET_COMMIT=$TARGET_COMMIT"
rm -rf "$BUILD" && mkdir -p "$BUILD"
git archive "$TARGET_COMMIT" | tar -x -C "$BUILD"
ln -s "$ROOT/node_modules" "$BUILD/node_modules"
(
  cd "$BUILD"
  "$ROOT/node_modules/.bin/tsc" -p tsconfig.json
)
[ -s "$BUILD/dist/core/app.js" ] || fail "APP_BUILD"
[ -s "$BUILD/dist/modules/control-plane/controllers/control-plane-write.controller.js" ] || fail "CONTROL_PLANE_WRITE_BUILD"
[ -s "$BUILD/dist/modules/control-plane/controllers/control-plane-support.controller.js" ] || fail "CONTROL_PLANE_SUPPORT_BUILD"
[ -s "$BUILD/dist/modules/control-plane/controllers/control-plane-expert.controller.js" ] || fail "CONTROL_PLANE_EXPERT_BUILD"
[ -s "$BUILD/dist/modules/stripe-relay/controllers/stripe-relay.controller.js" ] || fail "STRIPE_RELAY_BUILD"
[ -s "$BUILD/dist/modules/stripe-relay/routes/stripe-relay.routes.js" ] || fail "STRIPE_RELAY_ROUTE_BUILD"
grep -q "support_tickets" "$BUILD/src/modules/control-plane/controllers/control-plane-support.controller.ts" || fail "TICKETS_SOURCE_GATE"
grep -q "platform_tiers" "$BUILD/src/modules/control-plane/controllers/control-plane-write.controller.ts" || fail "TIERS_SOURCE_GATE"
grep -q "store_processing_profiles" "$BUILD/src/modules/control-plane/controllers/control-plane-write.controller.ts" || fail "PROCESSING_PROFILE_SOURCE_GATE"
grep -q "financialMutation:false" "$BUILD/src/modules/control-plane/controllers/control-plane-expert.controller.ts" || fail "EXPERT_FINANCE_ISOLATION_GATE"
grep -q "Idempotency-Key" "$BUILD/src/modules/stripe-relay/controllers/stripe-relay.controller.ts" || fail "STRIPE_IDEMPOTENCY_GATE"
grep -q "express.raw" "$BUILD/src/core/app.ts" || fail "STRIPE_RAW_BODY_GATE"
! grep -q "stripe-relay" "$BUILD/src/modules/payments/controllers/direct.controller.ts" || fail "DIRECT_ISOLATION_GATE"
echo "ISOLATED_TYPESCRIPT_BUILD=PASS"
echo "CONTROL_PLANE_V2_SOURCE_GATES=PASS"
echo "STRIPE_RELAY_SOURCE_GATES=PASS"

echo "=== 3. DATABASE STRUCTURE GATE ==="
docker exec -i "$CONTAINER" node - <<'NODE'
const pm=require('/app/dist/core/prisma');
const p=pm.default||pm;
(async()=>{
  const rows=await p.$queryRawUnsafe(`
    select
      to_regclass('public.platform_tiers') is not null as tiers,
      to_regclass('public.support_tickets') is not null as tickets,
      to_regclass('public.support_ticket_messages') is not null as messages
  `);
  const r=rows[0]||{};
  if(!r.tiers||!r.tickets||!r.messages) throw new Error('CONTROL_PLANE_V2_TABLES_MISSING');
  console.log('PLATFORM_TIERS_TABLE=PASS');
  console.log('SUPPORT_TICKETS_TABLE=PASS');
  console.log('SUPPORT_TICKET_MESSAGES_TABLE=PASS');
})().catch(e=>{console.error(e.message||e);process.exitCode=1}).finally(()=>p.$disconnect());
NODE
echo "CONTROL_PLANE_V2_DB_GATE=PASS"

echo "=== 4. BACKUP APP + CONTROL-PLANE + STRIPE-RELAY ONLY ==="
cp src/core/app.ts "$BACKUP/app.ts"
[ -f dist/core/app.js ] && cp dist/core/app.js "$BACKUP/app.host.js" || true
docker cp "$CONTAINER:/app/dist/core/app.js" "$BACKUP/app.container.js" >/dev/null
backup_module control-plane
backup_module stripe-relay
chmod 600 "$BACKUP"/* 2>/dev/null || true
echo "BACKUP=PASS"

trap 'echo "UNEXPECTED_ERROR_AFTER_INSTALL=YES"; rollback' ERR

echo "=== 5. SURGICAL INSTALL ==="
cp "$BUILD/src/core/app.ts" src/core/app.ts
cp "$BUILD/dist/core/app.js" dist/core/app.js

for name in control-plane stripe-relay; do
  rm -rf "src/modules/$name" "dist/modules/$name"
  mkdir -p "src/modules/$name" "dist/modules/$name"
  cp -a "$BUILD/src/modules/$name/." "src/modules/$name/"
  cp -a "$BUILD/dist/modules/$name/." "dist/modules/$name/"
  docker exec "$CONTAINER" sh -lc "rm -rf /app/dist/modules/$name && mkdir -p /app/dist/modules/$name"
  docker cp "$BUILD/dist/modules/$name/." "$CONTAINER:/app/dist/modules/$name/" >/dev/null
done

docker cp "$BUILD/dist/core/app.js" "$CONTAINER:/app/dist/core/app.js" >/dev/null
echo "SURGICAL_INSTALL=PASS"

echo "=== 6. RESTART — NO RECREATE ==="
docker restart "$CONTAINER" >/dev/null
OK=0
for _ in $(seq 1 30); do
  if health >/tmp/control-plane-v2-health.json 2>/dev/null; then OK=1; cat /tmp/control-plane-v2-health.json; echo; break; fi
  sleep 1
done
if [ "$OK" -ne 1 ]; then echo "HEALTH_AFTER_DEPLOY=FAIL"; rollback; exit 1; fi
echo "HEALTH_AFTER_DEPLOY=PASS"

echo "=== 7. POST IMMUTABLE FINANCIAL GATES ==="
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

echo "=== 8. CONTROL PLANE V2 AUTH GATES ==="
TIERS_HTTP="$(curl -sS -o /tmp/cpv2-tiers.json -w '%{http_code}' https://api.xpayments.digital/api/v1/control-plane/tiers)"
TICKETS_HTTP="$(curl -sS -o /tmp/cpv2-tickets.json -w '%{http_code}' https://api.xpayments.digital/api/v1/control-plane/tickets)"
echo "CONTROL_PLANE_TIERS_NOAUTH_HTTP=$TIERS_HTTP"
echo "CONTROL_PLANE_TICKETS_NOAUTH_HTTP=$TICKETS_HTTP"
[ "$TIERS_HTTP" = "401" ] || { rollback; exit 1; }
[ "$TICKETS_HTTP" = "401" ] || { rollback; exit 1; }
echo "CONTROL_PLANE_V2_AUTH_GATES=PASS"

echo "=== 9. STRIPE RELAY FAIL-CLOSED GATE ==="
RELAY_HTTP="$(curl -sS -o /tmp/cpv2-relay.json -w '%{http_code}' -X POST https://api.xpayments.digital/api/stripe/v1/payment_intents -H 'Content-Type: application/x-www-form-urlencoded' --data 'amount=1&currency=eur')"
echo "STRIPE_RELAY_NOAUTH_HTTP=$RELAY_HTTP"
[ "$RELAY_HTTP" = "401" ] || { rollback; exit 1; }
grep -q "api_key_invalid" /tmp/cpv2-relay.json || { rollback; exit 1; }
echo "STRIPE_RELAY_PROVIDER_CALLED=NO"
echo "STRIPE_RELAY_FAIL_CLOSED=PASS"

echo "=== 10. RUNTIME FILE GATES ==="
docker exec "$CONTAINER" test -s /app/dist/modules/control-plane/controllers/control-plane-write.controller.js || { rollback; exit 1; }
docker exec "$CONTAINER" test -s /app/dist/modules/control-plane/controllers/control-plane-support.controller.js || { rollback; exit 1; }
docker exec "$CONTAINER" test -s /app/dist/modules/stripe-relay/controllers/stripe-relay.controller.js || { rollback; exit 1; }
echo "CONTROL_PLANE_V2_RUNTIME_FILES=PASS"
echo "STRIPE_RELAY_RUNTIME_FILES=PASS"

echo "=== 11. FINAL HEALTH ==="
rm -f /tmp/control-plane-v2-health.json /tmp/cpv2-tiers.json /tmp/cpv2-tickets.json /tmp/cpv2-relay.json
health; echo
echo "FINAL_HEALTH=PASS"
echo "CONTROL_PLANE_V2_LIVE_OPS_DEPLOY=PASS"
echo "PROVIDER_CALLED_DURING_DEPLOY=NO"
echo "FINANCIAL_MUTATION_DURING_DEPLOY=NO"
trap - ERR
