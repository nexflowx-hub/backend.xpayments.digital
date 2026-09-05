#!/usr/bin/env bash
set -Eeuo pipefail

APP=/root/xpayments-backend-v3
BRANCH=feat/checkout-vnext-20260905
REMOTE_REF=origin/${BRANCH}
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
REPORT="/root/xpayments-checkout-final-go-live-${STAMP}.txt"

exec > >(tee -a "$REPORT") 2>&1

cd "$APP"

echo "======================================================"
echo " XPAYMENTS CHECKOUT VNEXT — FINAL GO LIVE"
echo "======================================================"

git fetch origin "$BRANCH"
echo "REMOTE_HEAD=$(git rev-parse "$REMOTE_REF")"

for script in \
  deploy-checkout-vnext-prod.sh \
  deploy-checkout-branding-prod.sh \
  test-checkout-vnext-sandbox.sh
do
  git show "$REMOTE_REF:scripts/$script" > "/root/$script"
  chmod 700 "/root/$script"
done

echo
echo "=== 1. CHECKOUT CORE ==="
CORE_RC=0
bash /root/deploy-checkout-vnext-prod.sh || CORE_RC=$?
echo "CHECKOUT_CORE_RC=$CORE_RC"
if [ "$CORE_RC" -ne 0 ]; then
  echo "FINAL_GO_LIVE_ABORTED_AT=CHECKOUT_CORE"
  exit "$CORE_RC"
fi

echo
echo "=== 2. CHECKOUT BRANDING API ==="
BRANDING_RC=0
bash /root/deploy-checkout-branding-prod.sh || BRANDING_RC=$?
echo "CHECKOUT_BRANDING_RC=$BRANDING_RC"
if [ "$BRANDING_RC" -ne 0 ]; then
  echo "FINAL_GO_LIVE_ABORTED_AT=BRANDING"
  exit "$BRANDING_RC"
fi

echo
echo "=== 3. SANDBOX E2E ==="
E2E_RC=0
bash /root/test-checkout-vnext-sandbox.sh || E2E_RC=$?
echo "CHECKOUT_E2E_RC=$E2E_RC"

echo
echo "=== 4. FINAL HEALTH ==="
curl -fsS https://api.xpayments.digital/api/health
echo

DIRECT_SHA="$(sha256sum src/modules/payments/controllers/direct.controller.ts | awk '{print $1}')"
echo "DIRECT_CONTROLLER_FINAL_SHA=$DIRECT_SHA"
echo "REPORT=$REPORT"

if [ "$E2E_RC" -eq 0 ]; then
  echo "XPAYMENTS_CHECKOUT_FINAL_GO_LIVE=PASS"
  exit 0
fi

echo "XPAYMENTS_CHECKOUT_FINAL_GO_LIVE=PARTIAL_E2E_PENDING"
exit "$E2E_RC"
