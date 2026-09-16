#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="/root/xpayments-backend-v3"
SERVICE="xpayments-api-v3"
FEATURE_BRANCH="feat/pagarpix-functional-v3-pix-runtime"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORKROOT="/root/.xpayments-pagarpix-commercial-v3/${STAMP}"
FEATURE_SRC="${WORKROOT}/feature-src"
EXTRACT="${WORKROOT}/extract"

BASELINE_IMAGE="xpayments-prod-pre-pagarpix-v3:${STAMP}"
FEATURE_IMAGE="xpayments-pagarpix-commercial-v3-feature:${STAMP}"
CANDIDATE_IMAGE="xpayments-pagarpix-commercial-v3:${STAMP}"
FEATURE_CONTAINER="xpayments-pagarpix-feature-${STAMP}"
CANDIDATE_CONTAINER="xpayments-pagarpix-candidate-${STAMP}"

AUTH_CONTROLLER_PATH="/app/dist/modules/auth/controllers/auth.controller.js"
AUTH_ROUTES_PATH="/app/dist/modules/auth/routes/auth.routes.js"
PIX_ROUTER_PATH="/app/dist/modules/payments/services/pix-router.service.js"
PIX_ROUTING_V3_PATH="/app/dist/modules/payments/services/pix-routing-v3.service.js"
APP_PATH="/app/dist/core/app.js"
PAYMENTS_ROUTES_PATH="/app/dist/modules/payments/routes/payments.routes.js"

DEPLOY_STARTED=0
SERVICE_IMAGE_REF=""

section() {
  echo
  echo "======================================================"
  echo "$1"
  echo "======================================================"
}

cleanup() {
  docker rm -f "$FEATURE_CONTAINER" "$CANDIDATE_CONTAINER" >/dev/null 2>&1 || true
  if [ -d "$FEATURE_SRC" ]; then
    git -C "$ROOT" worktree remove --force "$FEATURE_SRC" >/dev/null 2>&1 || true
  fi
}

wait_health() {
  local i
  for i in $(seq 1 45); do
    if curl -fsS --max-time 5 http://127.0.0.1:3001/api/health >/tmp/xpayments-pagarpix-v3-health.json 2>/dev/null; then
      cat /tmp/xpayments-pagarpix-v3-health.json
      echo
      return 0
    fi
    sleep 1
  done
  return 1
}

rollback() {
  local rc="$?"
  set +e
  echo
  echo "DEPLOY_ERROR_RC=${rc}"
  if [ "$DEPLOY_STARTED" = "1" ] && [ -n "$SERVICE_IMAGE_REF" ]; then
    echo "ROLLBACK: restoring ${BASELINE_IMAGE}"
    docker tag "$BASELINE_IMAGE" "$SERVICE_IMAGE_REF"
    docker rm -f "$SERVICE" >/dev/null 2>&1 || true
    cd "$ROOT"
    docker compose up -d --no-build "$SERVICE" >/dev/null 2>&1 || true
    wait_health || true
  fi
  cleanup
  exit "$rc"
}
trap rollback ERR
trap cleanup EXIT

mkdir -p "$WORKROOT" "$EXTRACT"

section "1. Production preflight"
docker inspect "$SERVICE" >/dev/null
SERVICE_IMAGE_REF="$(docker inspect -f '{{.Config.Image}}' "$SERVICE")"
echo "SERVICE_IMAGE_REF=${SERVICE_IMAGE_REF}"

curl -fsS --max-time 8 https://api.xpayments.digital/api/health
echo

for target in \
  "$AUTH_CONTROLLER_PATH" \
  "$AUTH_ROUTES_PATH" \
  "$PIX_ROUTER_PATH" \
  "$APP_PATH" \
  "$PAYMENTS_ROUTES_PATH"; do
  docker exec "$SERVICE" test -f "$target"
  echo "$(docker exec "$SERVICE" sha256sum "$target")"
done

docker exec "$SERVICE" grep -q "/api/stripe/v1" "$APP_PATH"
docker exec "$SERVICE" grep -q "webhooks/misticpay" "$PAYMENTS_ROUTES_PATH"

echo "PRODUCTION_PREFLIGHT=PASS"

section "2. Snapshot exact current production"
docker commit "$SERVICE" "$BASELINE_IMAGE" >/dev/null
echo "BASELINE_IMAGE=${BASELINE_IMAGE}"

section "3. Build immutable PagarPIX runtime artifacts"
git -C "$ROOT" fetch origin "$FEATURE_BRANCH"
git -C "$ROOT" worktree add --detach "$FEATURE_SRC" "origin/$FEATURE_BRANCH"
FEATURE_HEAD="$(git -C "$FEATURE_SRC" rev-parse HEAD)"
echo "FEATURE_HEAD=${FEATURE_HEAD}"

docker build -t "$FEATURE_IMAGE" "$FEATURE_SRC" >/dev/null
docker create --name "$FEATURE_CONTAINER" "$FEATURE_IMAGE" >/dev/null

for target in \
  "$AUTH_CONTROLLER_PATH" \
  "$AUTH_ROUTES_PATH" \
  "$PIX_ROUTER_PATH" \
  "$PIX_ROUTING_V3_PATH"; do
  docker exec "$FEATURE_CONTAINER" test -f "$target"
  rel="${target#/app/}"
  mkdir -p "$EXTRACT/$(dirname "$rel")"
  docker cp "$FEATURE_CONTAINER:$target" "$EXTRACT/$rel"
done

echo "FEATURE_ARTIFACTS=PASS"

section "4. Build candidate from the live runtime"
docker create --name "$CANDIDATE_CONTAINER" "$BASELINE_IMAGE" >/dev/null

for target in \
  "$AUTH_CONTROLLER_PATH" \
  "$AUTH_ROUTES_PATH" \
  "$PIX_ROUTER_PATH" \
  "$PIX_ROUTING_V3_PATH"; do
  rel="${target#/app/}"
  mkdir -p "$EXTRACT/$(dirname "$rel")"
  docker cp "$EXTRACT/$rel" "$CANDIDATE_CONTAINER:$target"
done

section "5. Candidate syntax and contract validation"
docker start "$CANDIDATE_CONTAINER" >/dev/null 2>&1 || true
for target in \
  "$AUTH_CONTROLLER_PATH" \
  "$AUTH_ROUTES_PATH" \
  "$PIX_ROUTER_PATH" \
  "$PIX_ROUTING_V3_PATH"; do
  docker exec "$CANDIDATE_CONTAINER" node --check "$target" >/dev/null
done
docker stop "$CANDIDATE_CONTAINER" >/dev/null 2>&1 || true

docker commit "$CANDIDATE_CONTAINER" "$CANDIDATE_IMAGE" >/dev/null

docker run --rm --entrypoint sh "$CANDIDATE_IMAGE" -lc "
  grep -q 'pagarpix/register' '$AUTH_ROUTES_PATH' &&
  grep -q 'PagarPIX Conta BRL' '$AUTH_CONTROLLER_PATH' &&
  grep -q 'resolvePixRoutingV3' '$PIX_ROUTER_PATH' &&
  test -f '$PIX_ROUTING_V3_PATH' &&
  grep -q '/api/stripe/v1' '$APP_PATH' &&
  grep -q 'webhooks/misticpay' '$PAYMENTS_ROUTES_PATH'
"

echo "CANDIDATE_VALIDATION=PASS"

section "6. Deploy candidate"
DEPLOY_STARTED=1
docker tag "$CANDIDATE_IMAGE" "$SERVICE_IMAGE_REF"
docker rm -f "$SERVICE" >/dev/null
cd "$ROOT"
docker compose up -d --no-build "$SERVICE" >/dev/null
wait_health

section "7. Production contract verification"
docker exec "$SERVICE" grep -q "pagarpix/register" "$AUTH_ROUTES_PATH"
docker exec "$SERVICE" grep -q "PagarPIX Conta BRL" "$AUTH_CONTROLLER_PATH"
docker exec "$SERVICE" grep -q "resolvePixRoutingV3" "$PIX_ROUTER_PATH"
docker exec "$SERVICE" test -f "$PIX_ROUTING_V3_PATH"
docker exec "$SERVICE" grep -q "/api/stripe/v1" "$APP_PATH"
docker exec "$SERVICE" grep -q "webhooks/misticpay" "$PAYMENTS_ROUTES_PATH"

REGISTER_STATUS="$(curl -sS -o /tmp/pagarpix-register-probe.json -w '%{http_code}' \
  -H 'content-type: application/json' \
  -d '{}' \
  https://api.xpayments.digital/api/v1/auth/pagarpix/register)"
cat /tmp/pagarpix-register-probe.json
echo

test "$REGISTER_STATUS" = "400"
grep -Eq 'INVALID_EMAIL|INVALID_NAME|WEAK_PASSWORD' /tmp/pagarpix-register-probe.json

echo "PAGARPIX_REGISTER_PROBE=PASS"

echo
curl -fsS --max-time 8 https://api.xpayments.digital/api/health
echo

section "8. Deployment result"
echo "DEPLOY_STATUS=PASS"
echo "FEATURE_HEAD=${FEATURE_HEAD}"
echo "BASELINE_IMAGE=${BASELINE_IMAGE}"
echo "CANDIDATE_IMAGE=${CANDIDATE_IMAGE}"
echo "ROLLBACK_IMAGE=${BASELINE_IMAGE}"

echo
echo "NOTE: Routing V3 remains observer-only; real provider selection is still Store.routingRules.pix."

DEPLOY_STARTED=0
