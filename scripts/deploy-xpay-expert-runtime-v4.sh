#!/usr/bin/env bash
set -Eeuo pipefail

PROD_ROOT="/root/xpayments-backend-v3"
BRANCH="fix/checkout-signed-reconcile-20260907"
V3="/root/deploy-xpay-expert-runtime-v3-latest.sh"

cd "$PROD_ROOT"

git fetch origin "$BRANCH" >/dev/null 2>&1
TARGET_COMMIT="$(git rev-parse "origin/$BRANCH")"
echo "TARGET_COMMIT=$TARGET_COMMIT"

ROUTE_SOURCE="$(git show "origin/${BRANCH}:src/modules/expert/routes/expert.routes.ts")"
CONTROLLER_SOURCE="$(git show "origin/${BRANCH}:src/modules/expert/controllers/expert-payment-instructions.controller.ts")"

echo "$ROUTE_SOURCE" | grep -q "payment-instructions" || { echo "PAYMENT_INSTRUCTIONS_ROUTE_SOURCE=FAIL"; exit 1; }
echo "$CONTROLLER_SOURCE" | grep -q "getMerchantOrderPaymentInstructions" || { echo "PAYMENT_INSTRUCTIONS_CONTROLLER_SOURCE=FAIL"; exit 1; }
echo "PAYMENT_INSTRUCTIONS_SOURCE_GATES=PASS"

git show \
  "origin/${BRANCH}:scripts/deploy-xpay-expert-runtime-v3.sh" \
  >"$V3"
chmod 700 "$V3"

V3_RC=0
bash "$V3" || V3_RC=$?
echo "V3_RUNTIME_RC=$V3_RC"
[ "$V3_RC" -eq 0 ] || exit "$V3_RC"

echo "=== PAYMENT INSTRUCTIONS AUTH GATE ==="
HTTP="$(curl -sS -o /tmp/xpay-expert-payment-instructions-noauth.json -w '%{http_code}' \
  https://api.xpayments.digital/api/v1/expert/orders/00000000-0000-4000-8000-000000000001/payment-instructions)"
echo "PAYMENT_INSTRUCTIONS_NOAUTH_HTTP=$HTTP"
[ "$HTTP" = "401" ] || { echo "PAYMENT_INSTRUCTIONS_AUTH_GATE=FAIL"; exit 1; }
echo "PAYMENT_INSTRUCTIONS_AUTH_GATE=PASS"

rm -f /tmp/xpay-expert-payment-instructions-noauth.json

curl -fsS https://api.xpayments.digital/api/health
echo
echo "FINAL_HEALTH=PASS"
echo "XPAY_EXPERT_PAYMENT_INSTRUCTIONS_RUNTIME=PASS"
