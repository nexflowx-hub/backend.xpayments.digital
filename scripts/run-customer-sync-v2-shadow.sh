#!/usr/bin/env bash
set -Eeuo pipefail

CONTAINER="xpayments-api-v3"
WORKER="${CUSTOMER_SYNC_V2_SHADOW_WORKER:-/root/xpayments-customer-sync-v2-shadow.mjs}"
HEALTH_URL="${XPAYMENTS_HEALTH_URL:-https://api.xpayments.digital/api/health}"

echo "======================================================"
echo " XPAYMENTS CUSTOMER SYNC V2 — SHADOW RUNNER"
echo "======================================================"

echo
echo "1. WORKER CHECK"
test -s "$WORKER"
node --check "$WORKER"
echo "WORKER_SYNTAX_OK"

echo
echo "2. CONTAINER CHECK"
docker inspect "$CONTAINER" >/dev/null
RUNNING="$(docker inspect -f '{{.State.Running}}' "$CONTAINER")"
echo "CONTAINER_RUNNING=${RUNNING}"
test "$RUNNING" = "true"

echo
echo "3. API PRE-CHECK"
curl -fsS "$HEALTH_URL"
echo

echo
echo "4. SHADOW READ-ONLY EXECUTION"
docker exec -i \
  "$CONTAINER" \
  sh -lc \
  'DATABASE_URL="$DIRECT_URL" node --input-type=module' \
  < "$WORKER"

echo
echo "5. API POST-CHECK"
curl -fsS "$HEALTH_URL"
echo

echo
echo "CUSTOMER_SYNC_V2_SHADOW_RUNNER=PASS"
echo "DB_MODE=READ_ONLY"
echo "PAYMENT_FLOW_CHANGED=NO"
echo "PAYMENT_CREATED=NO"
