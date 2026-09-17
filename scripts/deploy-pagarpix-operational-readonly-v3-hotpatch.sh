#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="/root/xpayments-backend-v3"
SERVICE="xpayments-api-v3"
FEATURE_BRANCH="feat/pagarpix-functional-v3-pix-runtime"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORKROOT="/root/.xpayments-pagarpix-operational-v3/${STAMP}"
FEATURE_SRC="${WORKROOT}/feature-src"
EXTRACT="${WORKROOT}/extract"

BASELINE_IMAGE="xpayments-prod-pre-pagarpix-ops-v3:${STAMP}"
FEATURE_IMAGE="xpayments-pagarpix-ops-v3-feature:${STAMP}"
CANDIDATE_IMAGE="xpayments-pagarpix-ops-v3:${STAMP}"
FEATURE_CONTAINER="xpayments-pagarpix-ops-feature-${STAMP}"
CANDIDATE_CONTAINER="xpayments-pagarpix-ops-candidate-${STAMP}"

APP_PATH="/app/dist/core/app.js"
OPS_ROUTE_PATH="/app/dist/modules/pagarpix-operational/pagarpix-operational.routes.js"
AUTH_CONTROLLER_PATH="/app/dist/modules/auth/controllers/auth.controller.js"
AUTH_ROUTES_PATH="/app/dist/modules/auth/routes/auth.routes.js"
PAGARPIX_CONTROLLER_PATH="/app/dist/modules/auth/controllers/pagarpix-onboarding.controller.js"
PIX_CONTROLLER_PATH="/app/dist/modules/payments/controllers/pix.controller.js"
PIX_ROUTER_PATH="/app/dist/modules/payments/services/pix-router.service.js"
PIX_ROUTING_V3_PATH="/app/dist/modules/payments/services/pix-routing-v3.service.js"
PAYMENTS_ROUTES_PATH="/app/dist/modules/payments/routes/payments.routes.js"
PAYOUT_REQUEST_CONTROLLER_PATH="/app/dist/modules/payout-requests/controllers/payout-requests.controller.js"
PAYOUT_REQUEST_MIDDLEWARE_PATH="/app/dist/modules/payout-requests/middleware/payout-requests-feature.middleware.js"
PAYOUT_STATEMENTS_ROUTES_PATH="/app/dist/modules/payout-statements/routes/payout-statements.routes.js"

DEPLOY_STARTED=0
SERVICE_IMAGE_REF=""
FEATURE_HEAD=""

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
    if curl -fsS --max-time 5 http://127.0.0.1:3001/api/health >/tmp/xpayments-pagarpix-ops-health.json 2>/dev/null; then
      cat /tmp/xpayments-pagarpix-ops-health.json
      echo
      return 0
    fi
    sleep 1
  done
  return 1
}

container_sha() {
  docker exec "$SERVICE" sha256sum "$1" | awk '{print $1}'
}

image_sha() {
  docker run --rm --entrypoint sha256sum "$1" "$2" | awk '{print $1}'
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
  "$APP_PATH" \
  "$AUTH_CONTROLLER_PATH" \
  "$AUTH_ROUTES_PATH" \
  "$PAGARPIX_CONTROLLER_PATH" \
  "$PIX_CONTROLLER_PATH" \
  "$PIX_ROUTER_PATH" \
  "$PIX_ROUTING_V3_PATH" \
  "$PAYMENTS_ROUTES_PATH" \
  "$PAYOUT_REQUEST_CONTROLLER_PATH" \
  "$PAYOUT_REQUEST_MIDDLEWARE_PATH" \
  "$PAYOUT_STATEMENTS_ROUTES_PATH"; do
  docker exec "$SERVICE" test -f "$target"
done

AUTH_CONTROLLER_SHA="$(container_sha "$AUTH_CONTROLLER_PATH")"
AUTH_ROUTES_SHA="$(container_sha "$AUTH_ROUTES_PATH")"
PAGARPIX_CONTROLLER_SHA="$(container_sha "$PAGARPIX_CONTROLLER_PATH")"
PIX_CONTROLLER_SHA="$(container_sha "$PIX_CONTROLLER_PATH")"
PIX_ROUTER_SHA="$(container_sha "$PIX_ROUTER_PATH")"
PIX_ROUTING_V3_SHA="$(container_sha "$PIX_ROUTING_V3_PATH")"
PAYMENTS_ROUTES_SHA="$(container_sha "$PAYMENTS_ROUTES_PATH")"
PAYOUT_STATEMENTS_ROUTES_SHA="$(container_sha "$PAYOUT_STATEMENTS_ROUTES_PATH")"

docker exec "$SERVICE" grep -q "/api/stripe/v1" "$APP_PATH"
docker exec "$SERVICE" grep -q "webhooks/misticpay" "$PAYMENTS_ROUTES_PATH"
docker exec "$SERVICE" grep -q "pagarpix/register" "$AUTH_ROUTES_PATH"
docker exec "$SERVICE" grep -q "payout-statements" "$APP_PATH"

PAYOUT_FLAG="$(docker exec "$SERVICE" sh -lc 'printf %s "${PAYOUT_REQUESTS_ENABLED:-false}"')"
echo "PAYOUT_REQUESTS_ENABLED=${PAYOUT_FLAG}"
case "${PAYOUT_FLAG,,}" in
  1|true|yes|on) ;;
  *) echo "ERROR: PAYOUT_REQUESTS_ENABLED must be true for the read-only facade"; exit 1 ;;
esac

echo "PRODUCTION_PREFLIGHT=PASS"

section "2. Snapshot exact current production"
docker commit "$SERVICE" "$BASELINE_IMAGE" >/dev/null
echo "BASELINE_IMAGE=${BASELINE_IMAGE}"

section "3. Build immutable operational facade"
git -C "$ROOT" fetch origin "$FEATURE_BRANCH"
git -C "$ROOT" worktree add --detach "$FEATURE_SRC" "origin/$FEATURE_BRANCH"
FEATURE_HEAD="$(git -C "$FEATURE_SRC" rev-parse HEAD)"
echo "FEATURE_HEAD=${FEATURE_HEAD}"

docker build -t "$FEATURE_IMAGE" "$FEATURE_SRC" >/dev/null
docker run --rm --entrypoint sh "$FEATURE_IMAGE" -lc "test -f '$OPS_ROUTE_PATH'"
docker create --name "$FEATURE_CONTAINER" "$FEATURE_IMAGE" >/dev/null

rel="${OPS_ROUTE_PATH#/app/}"
mkdir -p "$EXTRACT/$(dirname "$rel")"
docker cp "$FEATURE_CONTAINER:$OPS_ROUTE_PATH" "$EXTRACT/$rel"
echo "OPERATIONAL_ARTIFACT=PASS"

section "4. Build candidate from live runtime"
docker create --name "$CANDIDATE_CONTAINER" "$BASELINE_IMAGE" >/dev/null
docker cp "$EXTRACT/$rel" "$CANDIDATE_CONTAINER:$OPS_ROUTE_PATH"

LIVE_APP_HOST="$EXTRACT/live-app.js"
docker cp "$CANDIDATE_CONTAINER:$APP_PATH" "$LIVE_APP_HOST"
python3 - "$LIVE_APP_HOST" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
route_marker = 'pagarpix-operational.routes'
mount_line = 'api.use(\'/\', require("../modules/pagarpix-operational/pagarpix-operational.routes").default);'
anchor = "app.use('/api/v1', api);"

if route_marker not in text:
    if text.count(anchor) != 1:
        raise SystemExit('APP_MOUNT_PATCH_ANCHOR_NOT_UNIQUE')
    text = text.replace(anchor, mount_line + '\n' + anchor, 1)

if text.count(route_marker) != 1:
    raise SystemExit('APP_OPERATIONAL_ROUTE_MARKER_NOT_UNIQUE')

path.write_text(text)
PY

docker cp "$LIVE_APP_HOST" "$CANDIDATE_CONTAINER:$APP_PATH"
docker commit "$CANDIDATE_CONTAINER" "$CANDIDATE_IMAGE" >/dev/null

section "5. Candidate validation"
docker run --rm --entrypoint node "$CANDIDATE_IMAGE" --check "$APP_PATH" >/dev/null
docker run --rm --entrypoint node "$CANDIDATE_IMAGE" --check "$OPS_ROUTE_PATH" >/dev/null

docker run --rm --entrypoint sh "$CANDIDATE_IMAGE" -lc "
  grep -q 'pagarpix-operational.routes' '$APP_PATH' &&
  grep -q '/api/stripe/v1' '$APP_PATH' &&
  grep -q 'payout-statements' '$APP_PATH' &&
  grep -q 'webhooks/misticpay' '$PAYMENTS_ROUTES_PATH' &&
  grep -q 'pagarpix/register' '$AUTH_ROUTES_PATH' &&
  grep -q \"'/payout-requests'\" '$OPS_ROUTE_PATH' &&
  grep -q \"'/routing/connections'\" '$OPS_ROUTE_PATH' &&
  grep -q \"'/routing/policies'\" '$OPS_ROUTE_PATH' &&
  grep -q \"'/routing/decisions'\" '$OPS_ROUTE_PATH' &&
  ! grep -Eq '\\.(post|put|patch|delete)\\(' '$OPS_ROUTE_PATH'
"

test "$(image_sha "$CANDIDATE_IMAGE" "$AUTH_CONTROLLER_PATH")" = "$AUTH_CONTROLLER_SHA"
test "$(image_sha "$CANDIDATE_IMAGE" "$AUTH_ROUTES_PATH")" = "$AUTH_ROUTES_SHA"
test "$(image_sha "$CANDIDATE_IMAGE" "$PAGARPIX_CONTROLLER_PATH")" = "$PAGARPIX_CONTROLLER_SHA"
test "$(image_sha "$CANDIDATE_IMAGE" "$PIX_CONTROLLER_PATH")" = "$PIX_CONTROLLER_SHA"
test "$(image_sha "$CANDIDATE_IMAGE" "$PIX_ROUTER_PATH")" = "$PIX_ROUTER_SHA"
test "$(image_sha "$CANDIDATE_IMAGE" "$PIX_ROUTING_V3_PATH")" = "$PIX_ROUTING_V3_SHA"
test "$(image_sha "$CANDIDATE_IMAGE" "$PAYMENTS_ROUTES_PATH")" = "$PAYMENTS_ROUTES_SHA"
test "$(image_sha "$CANDIDATE_IMAGE" "$PAYOUT_STATEMENTS_ROUTES_PATH")" = "$PAYOUT_STATEMENTS_ROUTES_SHA"

echo "PROTECTED_RUNTIME_SHA=PASS"
echo "OPERATIONAL_FACADE_MODE=READ_ONLY"
echo "CANDIDATE_VALIDATION=PASS"

section "6. Deploy candidate"
DEPLOY_STARTED=1
docker tag "$CANDIDATE_IMAGE" "$SERVICE_IMAGE_REF"
docker rm -f "$SERVICE" >/dev/null
cd "$ROOT"
docker compose up -d --no-build "$SERVICE" >/dev/null
wait_health

section "7. Production contract verification"
docker exec "$SERVICE" grep -q 'pagarpix-operational.routes' "$APP_PATH"
docker exec "$SERVICE" grep -q '/api/stripe/v1' "$APP_PATH"
docker exec "$SERVICE" grep -q 'payout-statements' "$APP_PATH"
docker exec "$SERVICE" grep -q 'webhooks/misticpay' "$PAYMENTS_ROUTES_PATH"
docker exec "$SERVICE" grep -q 'pagarpix/register' "$AUTH_ROUTES_PATH"
docker exec "$SERVICE" grep -q "'/payout-requests'" "$OPS_ROUTE_PATH"
docker exec "$SERVICE" grep -q "'/routing/connections'" "$OPS_ROUTE_PATH"
docker exec "$SERVICE" grep -q "'/routing/policies'" "$OPS_ROUTE_PATH"
docker exec "$SERVICE" grep -q "'/routing/decisions'" "$OPS_ROUTE_PATH"

test "$(container_sha "$AUTH_CONTROLLER_PATH")" = "$AUTH_CONTROLLER_SHA"
test "$(container_sha "$AUTH_ROUTES_PATH")" = "$AUTH_ROUTES_SHA"
test "$(container_sha "$PAGARPIX_CONTROLLER_PATH")" = "$PAGARPIX_CONTROLLER_SHA"
test "$(container_sha "$PIX_CONTROLLER_PATH")" = "$PIX_CONTROLLER_SHA"
test "$(container_sha "$PIX_ROUTER_PATH")" = "$PIX_ROUTER_SHA"
test "$(container_sha "$PIX_ROUTING_V3_PATH")" = "$PIX_ROUTING_V3_SHA"
test "$(container_sha "$PAYMENTS_ROUTES_PATH")" = "$PAYMENTS_ROUTES_SHA"
test "$(container_sha "$PAYOUT_STATEMENTS_ROUTES_PATH")" = "$PAYOUT_STATEMENTS_ROUTES_SHA"
echo "PROTECTED_RUNTIME_POST_DEPLOY_SHA=PASS"

PAYOUT_STATUS="$(curl -sS -o /tmp/pagarpix-payout-unauth.json -w '%{http_code}' https://api.xpayments.digital/api/v1/payout-requests)"
ROUTING_STATUS="$(curl -sS -o /tmp/pagarpix-routing-unauth.json -w '%{http_code}' https://api.xpayments.digital/api/v1/routing/connections)"

echo "PAYOUT_UNAUTH_STATUS=${PAYOUT_STATUS}"
echo "ROUTING_UNAUTH_STATUS=${ROUTING_STATUS}"
test "$PAYOUT_STATUS" = "401"
test "$ROUTING_STATUS" = "401"

echo "AUTHENTICATED_ROUTE_MOUNTS=PASS"

REGISTER_STATUS="$(curl -sS -o /tmp/pagarpix-register-probe.json -w '%{http_code}' -H 'content-type: application/json' -d '{}' https://api.xpayments.digital/api/v1/auth/pagarpix/register)"
test "$REGISTER_STATUS" = "400"
grep -Eq 'INVALID_EMAIL|INVALID_NAME|WEAK_PASSWORD' /tmp/pagarpix-register-probe.json
echo "PAGARPIX_REGISTER_PROBE=PASS"

curl -fsS --max-time 8 https://api.xpayments.digital/api/health
echo

section "8. Deployment result"
echo "DEPLOY_STATUS=PASS"
echo "FEATURE_HEAD=${FEATURE_HEAD}"
echo "BASELINE_IMAGE=${BASELINE_IMAGE}"
echo "CANDIDATE_IMAGE=${CANDIDATE_IMAGE}"
echo "ROLLBACK_IMAGE=${BASELINE_IMAGE}"
echo "PAGARPIX_PAYOUTS=READ_ONLY_MOUNTED"
echo "PAGARPIX_ROUTING=READ_ONLY_MOUNTED"
echo "PIX_PROVIDER_SELECTION=UNCHANGED_STORE_ROUTING_RULES"

DEPLOY_STARTED=0
