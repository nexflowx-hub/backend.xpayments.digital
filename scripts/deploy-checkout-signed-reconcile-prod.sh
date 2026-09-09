#!/usr/bin/env bash
set -Eeuo pipefail

APP=/root/xpayments-backend-v3
CONTAINER=xpayments-api-v3
REMOTE_BRANCH=fix/checkout-signed-reconcile-20260907
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="/root/xpayments-checkout-reconcile-${STAMP}"
REPORT="/root/xpayments-checkout-reconcile-${STAMP}.txt"
CHECKOUT_SRC="src/modules/checkout/controllers/checkout.controller.ts"
DIRECT_SRC="src/modules/payments/controllers/direct.controller.ts"
ROUTES_SRC="src/modules/payments/routes/payments.routes.ts"

exec > >(tee -a "$REPORT") 2>&1
cd "$APP"
mkdir -p "$BACKUP"

echo "======================================================"
echo " XPAYMENTS — TRUSTED CHECKOUT RECONCILIATION DEPLOY"
echo "======================================================"

wait_health() {
  local label="$1"
  local ok=0
  for i in $(seq 1 40); do
    if curl -fsS https://api.xpayments.digital/api/health >/tmp/xp-health.json 2>/dev/null; then
      ok=1
      break
    fi
    sleep 1
  done
  if [ "$ok" != "1" ]; then
    echo "${label}=FAIL"
    return 1
  fi
  cat /tmp/xp-health.json
  printf '\n'
  python3 - <<'PY'
import json
x=json.load(open('/tmp/xp-health.json'))
assert x.get('status') == 'ONLINE'
assert x.get('engine') == 'XPayments'
PY
  echo "${label}=PASS"
}

failure_diagnostics() {
  echo
  echo "=== FAILURE DIAGNOSTICS ==="
  docker logs --since 8m "$CONTAINER" 2>&1 \
    | grep -E "checkout\.providerReconcile|STRIPE WEBHOOK|MERCHANT_WEBHOOK|RZEURO-CHECKOUT-SBX-MBWAY|payment_intent" \
    | tail -n 220 || true
  echo "=== END FAILURE DIAGNOSTICS ==="
}

echo
echo "=== 0. PRE-FLIGHT ==="
wait_health "PRE_HEALTH"

grep -q "STRIPE WEBHOOK REJECTED" "$ROUTES_SRC"
grep -q "verifyStripeWebhookRequest" "$ROUTES_SRC"
grep -q "PROVIDER_RECONCILE_MIN_AGE_MS" "$CHECKOUT_SRC"
grep -q "executeCheckoutOrchestratedPayment" "$CHECKOUT_SRC"

echo "WEBHOOK_SIGNATURE_GUARD_PRESENT=PASS"
echo "CHECKOUT_VNEXT_PRESENT=PASS"

DIRECT_BEFORE="$(sha256sum "$DIRECT_SRC" | awk '{print $1}')"
ROUTES_BEFORE="$(sha256sum "$ROUTES_SRC" | awk '{print $1}')"
CHECKOUT_BEFORE="$(sha256sum "$CHECKOUT_SRC" | awk '{print $1}')"

echo "DIRECT_CONTROLLER_SHA_BEFORE=$DIRECT_BEFORE"
echo "PAYMENTS_ROUTES_SHA_BEFORE=$ROUTES_BEFORE"
echo "CHECKOUT_CONTROLLER_SHA_BEFORE=$CHECKOUT_BEFORE"

cp -a "$CHECKOUT_SRC" "$BACKUP/checkout.controller.ts"
docker cp "$CONTAINER:/app/dist/modules/checkout/controllers/checkout.controller.js" \
  "$BACKUP/checkout.controller.js" 2>/dev/null || true

rollback() {
  echo "ROLLBACK_START=1"
  cp -a "$BACKUP/checkout.controller.ts" "$CHECKOUT_SRC" || true
  if [ -f "$BACKUP/checkout.controller.js" ]; then
    docker cp "$BACKUP/checkout.controller.js" \
      "$CONTAINER:/app/dist/modules/checkout/controllers/checkout.controller.js" || true
  fi
  docker restart "$CONTAINER" >/dev/null || true
  if wait_health "ROLLBACK_HEALTH"; then
    echo "ROLLBACK_COMPLETE=1"
  else
    echo "ROLLBACK_COMPLETE=HEALTH_PENDING"
  fi
}

on_error() {
  local rc=$?
  trap - ERR
  echo "DEPLOY_FAILED=1"
  echo "DEPLOY_FAILURE_RC=$rc"
  failure_diagnostics
  rollback
  exit "$rc"
}
trap on_error ERR

echo
echo "=== 1. INSTALL VERSIONED SOURCE ==="
git fetch origin "$REMOTE_BRANCH"
git show "origin/$REMOTE_BRANCH:$CHECKOUT_SRC" >/tmp/xpayments-checkout-controller.ts

grep -q "handleStripeWebhook" /tmp/xpayments-checkout-controller.ts
grep -q "provider ownership mismatch" /tmp/xpayments-checkout-controller.ts
grep -q "internal processor failed" /tmp/xpayments-checkout-controller.ts
! grep -q "INTERNAL_STRIPE_WEBHOOK_URL" /tmp/xpayments-checkout-controller.ts
! grep -q "Stripe-Signature.*signatureTimestamp" /tmp/xpayments-checkout-controller.ts

echo "REMOTE_TRUSTED_RECONCILER=PASS"
cp /tmp/xpayments-checkout-controller.ts "$CHECKOUT_SRC"
echo "SOURCE_INSTALL=PASS"

echo
echo "=== 2. ISOLATED TRANSPILE ==="
docker exec "$CONTAINER" sh -lc '
set -e
cd /app
node <<"NODE"
const fs = require("fs");
const ts = require("typescript");
const sourcePath = "/app/src/modules/checkout/controllers/checkout.controller.ts";
const outPath = "/tmp/xpayments-checkout-trusted-reconcile.js";
const source = fs.readFileSync(sourcePath, "utf8");
const result = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    esModuleInterop: true,
    strict: true
  },
  reportDiagnostics: true,
  fileName: sourcePath
});
const errors = (result.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error);
if (errors.length) {
  for (const d of errors) console.error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  process.exit(1);
}
fs.writeFileSync(outPath, result.outputText);
console.log("ISOLATED_TRANSPILE=PASS");
NODE
'

echo
echo "=== 3. INSTALL ONLY CHECKOUT CONTROLLER ARTIFACT ==="
docker exec "$CONTAINER" sh -lc '
set -e
mkdir -p /app/dist/modules/checkout/controllers
cp /tmp/xpayments-checkout-trusted-reconcile.js \
  /app/dist/modules/checkout/controllers/checkout.controller.js
'

docker restart "$CONTAINER" >/dev/null
wait_health "HEALTH_AFTER_DEPLOY"

echo
echo "=== 4. SECURITY + S2S INVARIANTS ==="
DIRECT_AFTER="$(sha256sum "$DIRECT_SRC" | awk '{print $1}')"
ROUTES_AFTER="$(sha256sum "$ROUTES_SRC" | awk '{print $1}')"

[ "$DIRECT_BEFORE" = "$DIRECT_AFTER" ]
[ "$ROUTES_BEFORE" = "$ROUTES_AFTER" ]
grep -q "STRIPE WEBHOOK REJECTED" "$ROUTES_SRC"
grep -q "verifyStripeWebhookRequest" "$ROUTES_SRC"

echo "DIRECT_CONTROLLER_UNCHANGED=PASS"
echo "STRIPE_WEBHOOK_ROUTE_UNCHANGED=PASS"
echo "WEBHOOK_SIGNATURE_GUARD_STILL_PRESENT=PASS"

echo
echo "=== 5. SANDBOX E2E ==="
git show "origin/$REMOTE_BRANCH:scripts/test-checkout-vnext-sandbox.sh" \
  >/root/test-checkout-vnext-sandbox.sh
chmod 700 /root/test-checkout-vnext-sandbox.sh
bash /root/test-checkout-vnext-sandbox.sh

echo
echo "=== 6. POST-E2E INVARIANTS ==="
DIRECT_FINAL="$(sha256sum "$DIRECT_SRC" | awk '{print $1}')"
ROUTES_FINAL="$(sha256sum "$ROUTES_SRC" | awk '{print $1}')"
[ "$DIRECT_BEFORE" = "$DIRECT_FINAL" ]
[ "$ROUTES_BEFORE" = "$ROUTES_FINAL" ]
wait_health "FINAL_HEALTH"

echo "DIRECT_CONTROLLER_FINAL_UNCHANGED=PASS"
echo "STRIPE_WEBHOOK_ROUTE_FINAL_UNCHANGED=PASS"
echo "CHECKOUT_TRUSTED_RECONCILE_PROD_DEPLOY=PASS"
echo "BACKUP=$BACKUP"
echo "REPORT=$REPORT"
trap - ERR
