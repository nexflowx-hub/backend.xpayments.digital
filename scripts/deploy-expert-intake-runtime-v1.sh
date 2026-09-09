#!/usr/bin/env bash
set -Eeuo pipefail

PROD_ROOT="/root/xpayments-backend-v3"
CONTAINER="xpayments-api-v3"
BRANCH="fix/checkout-signed-reconcile-20260907"
EXPECTED_DIRECT="f4ac2ee6f982ed98f59b90ce45ec6b12691ed31bd1e84472510cbec90e696b32"
EXPECTED_ROUTES="31efe0f9e5d87b3224c7fb55042b4ea8f79ddd3b43b61cce6b5bd910d28a37e5"
EXPECTED_WEBHOOK="968826914cf620126ebcb675939518aa2685bc45715e7c6e6aec3b619ec64bfa"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BUILD="/root/expert-intake-build-${STAMP}"
BACKUP="/root/expert-intake-backup-${STAMP}"

health(){ curl -fsS https://api.xpayments.digital/api/health; }
fail(){ echo "$1=FAIL"; exit 1; }

cd "$PROD_ROOT"
mkdir -p "$BACKUP"

echo "======================================================"
echo " XPAYMENTS — EXPERT INTAKE RUNTIME DEPLOY V1"
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
docker exec "$CONTAINER" test -s /app/dist/modules/expert-ops/controllers/expert-ops.controller.js || fail "OPS_RUNTIME_PRE"
echo "FINANCIAL_INVARIANTS_PRE=PASS"
echo "SHARED_VAULT_PRE=PASS"
echo "ONBOARDING_AUTH_PRE=PASS"
echo "EXPERT_RUNTIME_PRE=PASS"
echo "OPS_RUNTIME_PRE=PASS"

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
[ -s "$BUILD/dist/modules/expert/controllers/expert-intake.controller.js" ] || fail "EXPERT_INTAKE_BUILD"
[ -s "$BUILD/dist/modules/expert/routes/expert.routes.js" ] || fail "EXPERT_ROUTE_BUILD"
[ -s "$BUILD/dist/modules/expert-ops/controllers/expert-ops-intake.controller.js" ] || fail "OPS_INTAKE_BUILD"
[ -s "$BUILD/dist/modules/expert-ops/controllers/expert-ops-queue.controller.js" ] || fail "OPS_QUEUE_BUILD"
[ -s "$BUILD/dist/modules/expert-ops/routes/expert-ops.routes.js" ] || fail "OPS_ROUTE_BUILD"
grep -q "payment-proofs" "$BUILD/src/modules/expert/routes/expert.routes.ts" || fail "EXPERT_PROOF_MARKER"
grep -q "intake-queue" "$BUILD/src/modules/expert-ops/routes/expert-ops.routes.ts" || fail "OPS_QUEUE_MARKER"
echo "ISOLATED_TYPESCRIPT_BUILD=PASS"

echo "=== 3. BACKUP TARGET FILES ONLY ==="
mkdir -p "$BACKUP/src-expert/controllers" "$BACKUP/src-expert/routes" "$BACKUP/src-ops/controllers" "$BACKUP/src-ops/routes" "$BACKUP/dist-expert/controllers" "$BACKUP/dist-expert/routes" "$BACKUP/dist-ops/controllers" "$BACKUP/dist-ops/routes"
cp src/modules/expert/routes/expert.routes.ts "$BACKUP/src-expert/routes/expert.routes.ts"
cp src/modules/expert-ops/routes/expert-ops.routes.ts "$BACKUP/src-ops/routes/expert-ops.routes.ts"
[ -f src/modules/expert/controllers/expert-intake.controller.ts ] && cp src/modules/expert/controllers/expert-intake.controller.ts "$BACKUP/src-expert/controllers/expert-intake.controller.ts" || true
[ -f src/modules/expert-ops/controllers/expert-ops-intake.controller.ts ] && cp src/modules/expert-ops/controllers/expert-ops-intake.controller.ts "$BACKUP/src-ops/controllers/expert-ops-intake.controller.ts" || true
[ -f src/modules/expert-ops/controllers/expert-ops-queue.controller.ts ] && cp src/modules/expert-ops/controllers/expert-ops-queue.controller.ts "$BACKUP/src-ops/controllers/expert-ops-queue.controller.ts" || true
[ -f dist/modules/expert/routes/expert.routes.js ] && cp dist/modules/expert/routes/expert.routes.js "$BACKUP/dist-expert/routes/expert.routes.js" || true
[ -f dist/modules/expert-ops/routes/expert-ops.routes.js ] && cp dist/modules/expert-ops/routes/expert-ops.routes.js "$BACKUP/dist-ops/routes/expert-ops.routes.js" || true
[ -f dist/modules/expert/controllers/expert-intake.controller.js ] && cp dist/modules/expert/controllers/expert-intake.controller.js "$BACKUP/dist-expert/controllers/expert-intake.controller.js" || true
[ -f dist/modules/expert-ops/controllers/expert-ops-intake.controller.js ] && cp dist/modules/expert-ops/controllers/expert-ops-intake.controller.js "$BACKUP/dist-ops/controllers/expert-ops-intake.controller.js" || true
[ -f dist/modules/expert-ops/controllers/expert-ops-queue.controller.js ] && cp dist/modules/expert-ops/controllers/expert-ops-queue.controller.js "$BACKUP/dist-ops/controllers/expert-ops-queue.controller.js" || true
chmod -R go-rwx "$BACKUP"
echo "BACKUP=PASS"

echo "=== 4. SURGICAL INSTALL ==="
cp "$BUILD/src/modules/expert/controllers/expert-intake.controller.ts" src/modules/expert/controllers/expert-intake.controller.ts
cp "$BUILD/src/modules/expert/routes/expert.routes.ts" src/modules/expert/routes/expert.routes.ts
cp "$BUILD/src/modules/expert-ops/controllers/expert-ops-intake.controller.ts" src/modules/expert-ops/controllers/expert-ops-intake.controller.ts
cp "$BUILD/src/modules/expert-ops/controllers/expert-ops-queue.controller.ts" src/modules/expert-ops/controllers/expert-ops-queue.controller.ts
cp "$BUILD/src/modules/expert-ops/routes/expert-ops.routes.ts" src/modules/expert-ops/routes/expert-ops.routes.ts
mkdir -p dist/modules/expert/controllers dist/modules/expert/routes dist/modules/expert-ops/controllers dist/modules/expert-ops/routes
cp "$BUILD/dist/modules/expert/controllers/expert-intake.controller.js" dist/modules/expert/controllers/expert-intake.controller.js
cp "$BUILD/dist/modules/expert/routes/expert.routes.js" dist/modules/expert/routes/expert.routes.js
cp "$BUILD/dist/modules/expert-ops/controllers/expert-ops-intake.controller.js" dist/modules/expert-ops/controllers/expert-ops-intake.controller.js
cp "$BUILD/dist/modules/expert-ops/controllers/expert-ops-queue.controller.js" dist/modules/expert-ops/controllers/expert-ops-queue.controller.js
cp "$BUILD/dist/modules/expert-ops/routes/expert-ops.routes.js" dist/modules/expert-ops/routes/expert-ops.routes.js
docker exec "$CONTAINER" sh -lc 'mkdir -p /app/dist/modules/expert/controllers /app/dist/modules/expert/routes /app/dist/modules/expert-ops/controllers /app/dist/modules/expert-ops/routes'
docker cp "$BUILD/dist/modules/expert/controllers/expert-intake.controller.js" "$CONTAINER:/app/dist/modules/expert/controllers/expert-intake.controller.js" >/dev/null
docker cp "$BUILD/dist/modules/expert/routes/expert.routes.js" "$CONTAINER:/app/dist/modules/expert/routes/expert.routes.js" >/dev/null
docker cp "$BUILD/dist/modules/expert-ops/controllers/expert-ops-intake.controller.js" "$CONTAINER:/app/dist/modules/expert-ops/controllers/expert-ops-intake.controller.js" >/dev/null
docker cp "$BUILD/dist/modules/expert-ops/controllers/expert-ops-queue.controller.js" "$CONTAINER:/app/dist/modules/expert-ops/controllers/expert-ops-queue.controller.js" >/dev/null
docker cp "$BUILD/dist/modules/expert-ops/routes/expert-ops.routes.js" "$CONTAINER:/app/dist/modules/expert-ops/routes/expert-ops.routes.js" >/dev/null
echo "SURGICAL_INSTALL=PASS"

echo "=== 5. RESTART — NO RECREATE ==="
docker restart "$CONTAINER" >/dev/null
OK=0
for _ in $(seq 1 30); do
  if health >/tmp/expert-intake-health.json 2>/dev/null; then OK=1; cat /tmp/expert-intake-health.json; echo; break; fi
  sleep 1
done
[ "$OK" -eq 1 ] || fail "HEALTH_AFTER_DEPLOY"
echo "HEALTH_AFTER_DEPLOY=PASS"

echo "=== 6. POST FINANCIAL GATES ==="
[ "$(sha256sum src/modules/payments/controllers/direct.controller.ts | awk '{print $1}')" = "$EXPECTED_DIRECT" ] || fail "DIRECT_POST"
[ "$(sha256sum src/modules/payments/routes/payments.routes.ts | awk '{print $1}')" = "$EXPECTED_ROUTES" ] || fail "ROUTES_POST"
[ "$(sha256sum src/modules/payments/controllers/stripe.webhook.ts | awk '{print $1}')" = "$EXPECTED_WEBHOOK" ] || fail "WEBHOOK_POST"
docker exec "$CONTAINER" grep -q "STRIPE WEBHOOK SHARED VAULT RESOLVED" "$VERIFIER_DIST" || fail "SHARED_VAULT_POST"
docker exec "$CONTAINER" grep -q "XPAY Sandbox" /app/dist/modules/auth/controllers/auth.controller.js || fail "ONBOARDING_AUTH_POST"
docker exec "$CONTAINER" test -s /app/dist/modules/expert/controllers/expert-payment-instructions.controller.js || fail "EXPERT_RUNTIME_POST"
docker exec "$CONTAINER" test -s /app/dist/modules/expert-ops/controllers/expert-ops.controller.js || fail "OPS_RUNTIME_POST"
echo "FINANCIAL_INVARIANTS_POST=PASS"
echo "SHARED_VAULT_POST=PASS"
echo "ONBOARDING_AUTH_POST=PASS"
echo "EXPERT_RUNTIME_POST=PASS"
echo "OPS_RUNTIME_POST=PASS"

echo "=== 7. NEW ROUTE AUTH GATES ==="
HTTP1="$(curl -sS -o /tmp/expert-intake-noauth.json -w '%{http_code}' https://api.xpayments.digital/api/v1/expert/orders/00000000-0000-4000-8000-000000000001/intake)"
HTTP2="$(curl -sS -o /tmp/expert-ops-intake-noauth.json -w '%{http_code}' https://api.xpayments.digital/api/v1/expert-ops/intake-queue)"
echo "EXPERT_INTAKE_NOAUTH_HTTP=$HTTP1"
echo "OPS_INTAKE_NOAUTH_HTTP=$HTTP2"
[ "$HTTP1" = "401" ] || fail "EXPERT_INTAKE_AUTH_GATE"
[ "$HTTP2" = "401" ] || fail "OPS_INTAKE_AUTH_GATE"
echo "EXPERT_INTAKE_AUTH_GATE=PASS"
echo "OPS_INTAKE_AUTH_GATE=PASS"

echo "=== 8. FINAL HEALTH ==="
rm -f /tmp/expert-intake-health.json /tmp/expert-intake-noauth.json /tmp/expert-ops-intake-noauth.json
health; echo
echo "FINAL_HEALTH=PASS"
echo "XPAY_EXPERT_INTAKE_RUNTIME_DEPLOY=PASS"
