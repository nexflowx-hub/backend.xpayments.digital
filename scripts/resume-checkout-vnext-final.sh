#!/usr/bin/env bash
set -Eeuo pipefail

APP=/root/xpayments-backend-v3
CONTAINER=xpayments-api-v3
BRANCH=feat/checkout-vnext-20260905
REMOTE_REF=origin/${BRANCH}
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
REPORT="/root/xpayments-checkout-resume-${STAMP}.txt"

exec > >(tee -a "$REPORT") 2>&1
cd "$APP"

wait_for_health() {
  local output_file="${1:-/tmp/xp-resume-health.json}"
  rm -f "$output_file"
  for i in $(seq 1 40); do
    if curl -fsS https://api.xpayments.digital/api/health >"$output_file" 2>/dev/null; then
      if python3 - "$output_file" <<'PY'
import json, sys
x=json.load(open(sys.argv[1]))
assert x.get('status') == 'ONLINE'
assert x.get('engine') == 'XPayments'
PY
      then
        return 0
      fi
    fi
    sleep 1
  done
  return 1
}

echo "======================================================"
echo " XPAYMENTS CHECKOUT VNEXT — RESUME FINAL GO LIVE"
echo "======================================================"

git fetch origin "$BRANCH"
echo "REMOTE_HEAD=$(git rev-parse "$REMOTE_REF")"

echo
echo "=== 0. RECOVER / VERIFY HEALTH ==="
if ! wait_for_health /tmp/xp-resume-pre-health.json; then
  echo "PRE_HEALTH=NOT_READY"
  docker restart "$CONTAINER" >/dev/null
  if ! wait_for_health /tmp/xp-resume-restart-health.json; then
    echo "HEALTH_RECOVERY=FAIL"
    docker ps --filter "name=$CONTAINER" --format 'CONTAINER={{.Names}} STATUS={{.Status}}' || true
    docker logs --tail 120 "$CONTAINER" || true
    exit 1
  fi
  echo "HEALTH_RECOVERY=PASS"
else
  echo "PRE_HEALTH=PASS"
fi

for script in deploy-developer-key-guard-prod.sh test-checkout-vnext-sandbox.sh; do
  git show "$REMOTE_REF:scripts/$script" > "/root/$script"
  chmod 700 "/root/$script"
done

echo
echo "=== 1. DEVELOPER API-KEY GUARD ==="
GUARD_RC=0
bash /root/deploy-developer-key-guard-prod.sh || GUARD_RC=$?
echo "DEVELOPER_GUARD_RC=$GUARD_RC"
if [ "$GUARD_RC" -ne 0 ]; then
  echo "RESUME_ABORTED_AT=DEVELOPER_GUARD"
  exit "$GUARD_RC"
fi

echo
echo "=== 2. CHECKOUT SANDBOX E2E ==="
E2E_RC=0
bash /root/test-checkout-vnext-sandbox.sh || E2E_RC=$?
echo "CHECKOUT_E2E_RC=$E2E_RC"

echo
echo "=== 3. FINAL HEALTH / S2S PROTECTION ==="
wait_for_health /tmp/xp-resume-final-health.json
cat /tmp/xp-resume-final-health.json
echo

DIRECT_SHA="$(sha256sum src/modules/payments/controllers/direct.controller.ts | awk '{print $1}')"
echo "DIRECT_CONTROLLER_FINAL_SHA=$DIRECT_SHA"
echo "REPORT=$REPORT"

if [ "$E2E_RC" -eq 0 ]; then
  echo "XPAYMENTS_CHECKOUT_RESUME_GO_LIVE=PASS"
  exit 0
fi

echo "XPAYMENTS_CHECKOUT_RESUME_GO_LIVE=PARTIAL_E2E_PENDING"
exit "$E2E_RC"
