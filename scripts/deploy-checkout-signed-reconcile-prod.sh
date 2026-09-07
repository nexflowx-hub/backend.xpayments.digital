#!/usr/bin/env bash
set -Eeuo pipefail

APP=/root/xpayments-backend-v3
CONTAINER=xpayments-api-v3
REMOTE_BRANCH=fix/checkout-signed-reconcile-20260907
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="/root/xpayments-checkout-signed-reconcile-${STAMP}"
REPORT="/root/xpayments-checkout-signed-reconcile-${STAMP}.txt"
CHECKOUT_SRC="src/modules/checkout/controllers/checkout.controller.ts"
DIRECT_SRC="src/modules/payments/controllers/direct.controller.ts"
ROUTES_SRC="src/modules/payments/routes/payments.routes.ts"

exec > >(tee -a "$REPORT") 2>&1

cd "$APP"
mkdir -p "$BACKUP"

echo "======================================================"
echo " XPAYMENTS — SIGNED CHECKOUT RECONCILIATION DEPLOY"
echo "======================================================"

echo
echo "=== 0. PRE-FLIGHT ==="
curl -fsS https://api.xpayments.digital/api/health >/tmp/xp-health-before.json
cat /tmp/xp-health-before.json

grep -q "STRIPE WEBHOOK REJECTED" "$ROUTES_SRC"
grep -q "verifyStripeWebhookRequest" "$ROUTES_SRC"
grep -q "internal webhook replay failed" "$CHECKOUT_SRC"
grep -q "INTERNAL_STRIPE_WEBHOOK_URL" "$CHECKOUT_SRC"

echo "WEBHOOK_SIGNATURE_GUARD_PRESENT=PASS"
echo "UNSIGNED_REPLAY_PRESENT=PASS"

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
  echo "ROLLBACK_COMPLETE=1"
}
trap 'echo "DEPLOY_FAILED=1"; rollback' ERR

echo
echo "=== 1. PATCH ONLY CHECKOUT RECONCILIATION ==="
python3 - <<'PY'
from pathlib import Path

path = Path('src/modules/checkout/controllers/checkout.controller.ts')
text = path.read_text()

old_credentials = """    const credentials = vault?.credentials as any;
    const secretKey = String(credentials?.secretKey || '').trim();
    if (!secretKey || !vault?.provider?.toLowerCase().startsWith('stripe')) return false;
"""

new_credentials = """    let credentials: any = vault?.credentials;
    if (typeof credentials === 'string') {
      try {
        credentials = JSON.parse(credentials);
      } catch {
        credentials = {};
      }
    }

    const secretKey = String(credentials?.secretKey || '').trim();
    const webhookSecret = String(credentials?.webhookSecret || '').trim();
    if (
      !secretKey ||
      !webhookSecret ||
      !vault?.provider?.toLowerCase().startsWith('stripe')
    ) return false;
"""

old_replay = """    const replayResponse = await fetch(INTERNAL_STRIPE_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: `evt_xpayments_checkout_reconcile_${providerId}_${paymentIntent.status}`,
        object: 'event',
        type: eventType,
        data: { object: paymentIntent }
      })
    });
"""

new_replay = """    const eventPayload = JSON.stringify({
      id: `evt_xpayments_checkout_reconcile_${providerId}_${paymentIntent.status}`,
      object: 'event',
      api_version: '2026-06-24.dahlia',
      created: Math.floor(Date.now() / 1000),
      livemode: Boolean(paymentIntent?.livemode),
      pending_webhooks: 0,
      type: eventType,
      data: { object: paymentIntent }
    });

    const signatureTimestamp = Math.floor(Date.now() / 1000);
    const signature = crypto
      .createHmac('sha256', webhookSecret)
      .update(`${signatureTimestamp}.${eventPayload}`, 'utf8')
      .digest('hex');

    const replayResponse = await fetch(INTERNAL_STRIPE_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': `t=${signatureTimestamp},v1=${signature}`,
        'X-XPayments-Internal-Reconcile': 'checkout-vnext'
      },
      body: eventPayload
    });
"""

if text.count(old_credentials) != 1:
    raise SystemExit('PATCH_ABORT: credentials block mismatch')
if text.count(old_replay) != 1:
    raise SystemExit('PATCH_ABORT: replay block mismatch')

text = text.replace(old_credentials, new_credentials)
text = text.replace(old_replay, new_replay)
path.write_text(text)
PY

grep -q "Stripe-Signature.*signatureTimestamp" "$CHECKOUT_SRC"
grep -q "createHmac('sha256', webhookSecret)" "$CHECKOUT_SRC"

echo "SIGNED_RECONCILIATION_PATCH=PASS"

echo
echo "=== 2. TRANSPILE ISOLATED CONTROLLER ==="
docker exec "$CONTAINER" sh -lc '
set -e
cd /app
node <<"NODE"
const fs = require("fs");
const ts = require("typescript");
const sourcePath = "/app/src/modules/checkout/controllers/checkout.controller.ts";
const outPath = "/tmp/xpayments-checkout-signed-reconcile.js";
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
cp /tmp/xpayments-checkout-signed-reconcile.js \
  /app/dist/modules/checkout/controllers/checkout.controller.js
'

docker restart "$CONTAINER" >/dev/null

for i in $(seq 1 30); do
  if curl -fsS https://api.xpayments.digital/api/health >/tmp/xp-health-after.json 2>/dev/null; then
    break
  fi
  sleep 1
done
cat /tmp/xp-health-after.json
python3 - <<'PY'
import json
x=json.load(open('/tmp/xp-health-after.json'))
assert x.get('status') == 'ONLINE'
assert x.get('engine') == 'XPayments'
print('HEALTH_AFTER_DEPLOY=PASS')
PY

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
git fetch origin "$REMOTE_BRANCH"
git show "origin/$REMOTE_BRANCH:scripts/test-checkout-vnext-sandbox.sh" \
  >/root/test-checkout-vnext-sandbox.sh
chmod 700 /root/test-checkout-vnext-sandbox.sh

bash /root/test-checkout-vnext-sandbox.sh

echo
echo "=== 6. POST-E2E SECURITY CHECK ==="
DIRECT_FINAL="$(sha256sum "$DIRECT_SRC" | awk '{print $1}')"
ROUTES_FINAL="$(sha256sum "$ROUTES_SRC" | awk '{print $1}')"
[ "$DIRECT_BEFORE" = "$DIRECT_FINAL" ]
[ "$ROUTES_BEFORE" = "$ROUTES_FINAL" ]

echo "DIRECT_CONTROLLER_FINAL_UNCHANGED=PASS"
echo "STRIPE_WEBHOOK_ROUTE_FINAL_UNCHANGED=PASS"
echo "CHECKOUT_SIGNED_RECONCILE_PROD_DEPLOY=PASS"
echo "BACKUP=$BACKUP"
echo "REPORT=$REPORT"

trap - ERR
