#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="/root/xpayments-backend-v3"
CONTAINER="xpayments-api-v3"
BRANCH="fix/checkout-signed-reconcile-20260907"
EXPECTED_DIRECT="f4ac2ee6f982ed98f59b90ce45ec6b12691ed31bd1e84472510cbec90e696b32"
EXPECTED_ROUTES="31efe0f9e5d87b3224c7fb55042b4ea8f79ddd3b43b61cce6b5bd910d28a37e5"
EXPECTED_WEBHOOK="968826914cf620126ebcb675939518aa2685bc45715e7c6e6aec3b619ec64bfa"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BUILD="/root/stripe-compatible-v2-build-${STAMP}"
BACKUP="/root/stripe-compatible-v2-backup-${STAMP}"

health(){ curl -fsS https://api.xpayments.digital/api/health; }
fail(){ echo "$1=FAIL"; exit 1; }

FILES=(
  "src/modules/control-plane/controllers/control-plane-processing-profile.controller.ts"
  "src/modules/control-plane/routes/control-plane.routes.ts"
  "src/modules/developer/controllers/developer-elements.controller.ts"
  "src/modules/developer/routes/developer.routes.ts"
  "src/modules/stripe-relay/controllers/stripe-relay.controller.ts"
)
DIST_FILES=(
  "dist/modules/control-plane/controllers/control-plane-processing-profile.controller.js"
  "dist/modules/control-plane/routes/control-plane.routes.js"
  "dist/modules/developer/controllers/developer-elements.controller.js"
  "dist/modules/developer/routes/developer.routes.js"
  "dist/modules/stripe-relay/controllers/stripe-relay.controller.js"
)

backup_path(){
  local p="$1"
  mkdir -p "$BACKUP/host/$(dirname "$p")" "$BACKUP/container/$(dirname "$p")"
  if [ -f "$ROOT/$p" ]; then cp "$ROOT/$p" "$BACKUP/host/$p"; fi
  if [[ "$p" == dist/* ]] && docker exec "$CONTAINER" test -f "/app/$p"; then
    docker cp "$CONTAINER:/app/$p" "$BACKUP/container/$p" >/dev/null
  fi
}

restore_all(){
  trap - ERR
  set +e
  echo "ROLLBACK_START=YES"
  for p in "${FILES[@]}" "${DIST_FILES[@]}"; do
    if [ -f "$BACKUP/host/$p" ]; then
      mkdir -p "$ROOT/$(dirname "$p")"
      cp "$BACKUP/host/$p" "$ROOT/$p"
    else
      rm -f "$ROOT/$p"
    fi
  done
  for p in "${DIST_FILES[@]}"; do
    if [ -f "$BACKUP/container/$p" ]; then
      docker exec "$CONTAINER" mkdir -p "/app/$(dirname "$p")"
      docker cp "$BACKUP/container/$p" "$CONTAINER:/app/$p" >/dev/null 2>&1
    else
      docker exec "$CONTAINER" rm -f "/app/$p" >/dev/null 2>&1
    fi
  done
  docker restart "$CONTAINER" >/dev/null 2>&1
  sleep 3
  health || true
  echo
  echo "ROLLBACK_COMPLETE=YES"
}

cd "$ROOT"
mkdir -p "$BUILD" "$BACKUP"

echo "======================================================"
echo " XPAYMENTS — STRIPE-COMPATIBLE V2 SAFE DEPLOY"
echo "======================================================"

echo "=== 1. PRE HEALTH / IMMUTABLE GATES ==="
health; echo
[ "$(sha256sum src/modules/payments/controllers/direct.controller.ts | awk '{print $1}')" = "$EXPECTED_DIRECT" ] || fail "DIRECT_PRE"
[ "$(sha256sum src/modules/payments/routes/payments.routes.ts | awk '{print $1}')" = "$EXPECTED_ROUTES" ] || fail "PAYMENT_ROUTES_PRE"
[ "$(sha256sum src/modules/payments/controllers/stripe.webhook.ts | awk '{print $1}')" = "$EXPECTED_WEBHOOK" ] || fail "WEBHOOK_PRE"
VERIFIER_DIST="$(docker exec "$CONTAINER" sh -lc "find /app/dist -type f -name 'stripe-webhook-verification.service.js' -print -quit")"
[ -n "$VERIFIER_DIST" ] || fail "VERIFIER_FOUND"
docker exec "$CONTAINER" grep -q "STRIPE WEBHOOK SHARED VAULT RESOLVED" "$VERIFIER_DIST" || fail "SHARED_VAULT_PRE"
echo "FINANCIAL_INVARIANTS_PRE=PASS"
echo "SHARED_VAULT_PRE=PASS"

echo "=== 2. ISOLATED BUILD / SOURCE GATES ==="
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
for p in "${FILES[@]}" "${DIST_FILES[@]}"; do
  [ -s "$BUILD/$p" ] || fail "BUILD_FILE_MISSING"
done
grep -q "V1.*VNEXT\|rawRuntime === 'V1'" "$BUILD/src/modules/control-plane/controllers/control-plane-processing-profile.controller.ts" || fail "PROCESSING_PROFILE_NORMALIZATION_GATE"
grep -q "publishableKey" "$BUILD/src/modules/developer/controllers/developer-elements.controller.ts" || fail "ELEMENTS_PUBLIC_KEY_GATE"
! grep -q "webhookSecret.*res\|secretKey.*res" "$BUILD/src/modules/developer/controllers/developer-elements.controller.ts" || fail "ELEMENTS_SECRET_EXPOSURE_GATE"
grep -q "metadata\[nexflowx_transaction_id\]" "$BUILD/src/modules/stripe-relay/controllers/stripe-relay.controller.ts" || fail "RELAY_CORRELATION_GATE"
grep -q "PAYMENT_INTENT_NOT_OWNED" "$BUILD/src/modules/stripe-relay/controllers/stripe-relay.controller.ts" || fail "RELAY_OWNERSHIP_GATE"
grep -q "source_mode='STRIPE_COMPAT'" "$BUILD/src/modules/stripe-relay/controllers/stripe-relay.controller.ts" || fail "RELAY_SOURCE_MODE_GATE"
grep -q "authorization.toLowerCase().startsWith('basic ')" "$BUILD/src/modules/stripe-relay/controllers/stripe-relay.controller.ts" || fail "RELAY_BASIC_AUTH_GATE"
echo "ISOLATED_TYPESCRIPT_BUILD=PASS"
echo "PROCESSING_PROFILE_FIX_SOURCE=PASS"
echo "ELEMENTS_CONFIG_SOURCE=PASS"
echo "STRIPE_RELAY_CORRELATION_SOURCE=PASS"
echo "STRIPE_RELAY_STORE_ISOLATION_SOURCE=PASS"

echo "=== 3. BACKUP TARGET FILES ONLY ==="
for p in "${FILES[@]}" "${DIST_FILES[@]}"; do backup_path "$p"; done
chmod -R go-rwx "$BACKUP" 2>/dev/null || true
echo "BACKUP=PASS"

trap 'echo "UNEXPECTED_ERROR_AFTER_INSTALL=YES"; restore_all; exit 1' ERR

echo "=== 4. SURGICAL INSTALL ==="
for p in "${FILES[@]}" "${DIST_FILES[@]}"; do
  mkdir -p "$ROOT/$(dirname "$p")"
  cp "$BUILD/$p" "$ROOT/$p"
done
for p in "${DIST_FILES[@]}"; do
  docker exec "$CONTAINER" mkdir -p "/app/$(dirname "$p")"
  docker cp "$BUILD/$p" "$CONTAINER:/app/$p" >/dev/null
done
echo "SURGICAL_INSTALL=PASS"

echo "=== 5. RESTART — NO RECREATE ==="
docker restart "$CONTAINER" >/dev/null
OK=0
for _ in $(seq 1 30); do
  if health >/tmp/xpayments-stripe-compat-health.json 2>/dev/null; then OK=1; cat /tmp/xpayments-stripe-compat-health.json; echo; break; fi
  sleep 1
done
[ "$OK" -eq 1 ] || { echo "HEALTH_AFTER_DEPLOY=FAIL"; restore_all; exit 1; }
echo "HEALTH_AFTER_DEPLOY=PASS"

echo "=== 6. POST IMMUTABLE GATES ==="
[ "$(sha256sum src/modules/payments/controllers/direct.controller.ts | awk '{print $1}')" = "$EXPECTED_DIRECT" ] || { restore_all; exit 1; }
[ "$(sha256sum src/modules/payments/routes/payments.routes.ts | awk '{print $1}')" = "$EXPECTED_ROUTES" ] || { restore_all; exit 1; }
[ "$(sha256sum src/modules/payments/controllers/stripe.webhook.ts | awk '{print $1}')" = "$EXPECTED_WEBHOOK" ] || { restore_all; exit 1; }
docker exec "$CONTAINER" grep -q "STRIPE WEBHOOK SHARED VAULT RESOLVED" "$VERIFIER_DIST" || { restore_all; exit 1; }
echo "FINANCIAL_INVARIANTS_POST=PASS"
echo "SHARED_VAULT_POST=PASS"

echo "=== 7. FAIL-CLOSED HTTP GATES — NO PROVIDER ==="
RELAY_HTTP="$(curl -sS -o /tmp/xpay-relay-noauth.json -w '%{http_code}' -X POST https://api.xpayments.digital/api/stripe/v1/payment_intents -H 'Content-Type: application/x-www-form-urlencoded' --data 'amount=100&currency=eur')"
ELEMENTS_HTTP="$(curl -sS -o /tmp/xpay-elements-noauth.json -w '%{http_code}' https://api.xpayments.digital/api/v1/developer/stores/00000000-0000-0000-0000-000000000000/elements-config)"
PROFILE_HTTP="$(curl -sS -o /tmp/xpay-profile-noauth.json -w '%{http_code}' -X PUT https://api.xpayments.digital/api/v1/control-plane/stores/00000000-0000-0000-0000-000000000000/processing-profile -H 'Content-Type: application/json' --data '{}')"
echo "STRIPE_RELAY_NOAUTH_HTTP=$RELAY_HTTP"
echo "ELEMENTS_CONFIG_NOAUTH_HTTP=$ELEMENTS_HTTP"
echo "PROCESSING_PROFILE_NOAUTH_HTTP=$PROFILE_HTTP"
[ "$RELAY_HTTP" = "401" ] || { restore_all; exit 1; }
[ "$ELEMENTS_HTTP" = "401" ] || { restore_all; exit 1; }
[ "$PROFILE_HTTP" = "401" ] || { restore_all; exit 1; }
grep -q "api_key_invalid" /tmp/xpay-relay-noauth.json || { restore_all; exit 1; }
echo "FAIL_CLOSED_GATES=PASS"
echo "PROVIDER_CALLED_DURING_DEPLOY=NO"

echo "=== 8. RUNTIME FILE GATES ==="
docker exec "$CONTAINER" grep -q "PAYMENT_INTENT_NOT_OWNED" /app/dist/modules/stripe-relay/controllers/stripe-relay.controller.js || { restore_all; exit 1; }
docker exec "$CONTAINER" grep -q "publishableKey" /app/dist/modules/developer/controllers/developer-elements.controller.js || { restore_all; exit 1; }
docker exec "$CONTAINER" grep -q "INVALID_RUNTIME_GENERATION" /app/dist/modules/control-plane/controllers/control-plane-processing-profile.controller.js || { restore_all; exit 1; }
echo "STRIPE_RELAY_RUNTIME=PASS"
echo "ELEMENTS_CONFIG_RUNTIME=PASS"
echo "PROCESSING_PROFILE_FIX_RUNTIME=PASS"

echo "=== 9. FINAL HEALTH ==="
rm -f /tmp/xpayments-stripe-compat-health.json /tmp/xpay-relay-noauth.json /tmp/xpay-elements-noauth.json /tmp/xpay-profile-noauth.json
health; echo
echo "FINAL_HEALTH=PASS"
echo "STRIPE_COMPATIBLE_V2_RUNTIME_DEPLOY=PASS"
echo "DB_MUTATION_DURING_DEPLOY=NO"
echo "FINANCIAL_MUTATION_DURING_DEPLOY=NO"
echo "PROVIDER_CALLED_DURING_DEPLOY=NO"
trap - ERR
