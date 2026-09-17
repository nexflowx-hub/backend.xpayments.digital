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
PAGARPIX_CONTROLLER_PATH="/app/dist/modules/auth/controllers/pagarpix-onboarding.controller.js"
AUTH_ROUTES_PATH="/app/dist/modules/auth/routes/auth.routes.js"
PIX_CONTROLLER_PATH="/app/dist/modules/payments/controllers/pix.controller.js"
PIX_ROUTER_PATH="/app/dist/modules/payments/services/pix-router.service.js"
PIX_ROUTING_V3_PATH="/app/dist/modules/payments/services/pix-routing-v3.service.js"
APP_PATH="/app/dist/core/app.js"
PAYMENTS_ROUTES_PATH="/app/dist/modules/payments/routes/payments.routes.js"

DEPLOY_STARTED=0
SERVICE_IMAGE_REF=""
PIX_CONTROLLER_USES_ROUTER=0
AUTH_CONTROLLER_SHA=""
PIX_CONTROLLER_SHA=""
APP_SHA=""
PAYMENTS_ROUTES_SHA=""

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

image_sha() {
  local image="$1"
  local path="$2"
  docker run --rm --entrypoint sha256sum "$image" "$path" | awk '{print $1}'
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
  "$PIX_CONTROLLER_PATH" \
  "$APP_PATH" \
  "$PAYMENTS_ROUTES_PATH"; do
  docker exec "$SERVICE" test -f "$target"
  docker exec "$SERVICE" sha256sum "$target"
done

if docker exec "$SERVICE" test -f "$PIX_ROUTER_PATH"; then
  echo "PIX_ROUTER_BASELINE=PRESENT"
  docker exec "$SERVICE" sha256sum "$PIX_ROUTER_PATH"
else
  echo "PIX_ROUTER_BASELINE=ABSENT_OPTIONAL"
fi

AUTH_CONTROLLER_SHA="$(docker exec "$SERVICE" sha256sum "$AUTH_CONTROLLER_PATH" | awk '{print $1}')"
PIX_CONTROLLER_SHA="$(docker exec "$SERVICE" sha256sum "$PIX_CONTROLLER_PATH" | awk '{print $1}')"
APP_SHA="$(docker exec "$SERVICE" sha256sum "$APP_PATH" | awk '{print $1}')"
PAYMENTS_ROUTES_SHA="$(docker exec "$SERVICE" sha256sum "$PAYMENTS_ROUTES_PATH" | awk '{print $1}')"

docker exec "$SERVICE" grep -q "/api/stripe/v1" "$APP_PATH"
docker exec "$SERVICE" grep -q "webhooks/misticpay" "$PAYMENTS_ROUTES_PATH"

if docker exec "$SERVICE" grep -Eq "pix-router\.service|executeRoutedPixPayment" "$PIX_CONTROLLER_PATH"; then
  PIX_CONTROLLER_USES_ROUTER=1
  echo "PIX_CONTROLLER_USES_ROUTER=YES"
else
  echo "PIX_CONTROLLER_USES_ROUTER=NO"
  echo "NOTE: onboarding will be deployed; Routing V3 observer will remain dormant until the live PIX controller is reconciled."
fi

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
docker run --rm --entrypoint sh "$FEATURE_IMAGE" -lc "
  test -f '$PAGARPIX_CONTROLLER_PATH' &&
  test -f '$PIX_ROUTER_PATH' &&
  test -f '$PIX_ROUTING_V3_PATH'
"
docker create --name "$FEATURE_CONTAINER" "$FEATURE_IMAGE" >/dev/null

for target in \
  "$PAGARPIX_CONTROLLER_PATH" \
  "$PIX_ROUTER_PATH" \
  "$PIX_ROUTING_V3_PATH"; do
  rel="${target#/app/}"
  mkdir -p "$EXTRACT/$(dirname "$rel")"
  docker cp "$FEATURE_CONTAINER:$target" "$EXTRACT/$rel"
done

echo "FEATURE_ARTIFACTS=PASS"

section "4. Build candidate from the live runtime"
docker create --name "$CANDIDATE_CONTAINER" "$BASELINE_IMAGE" >/dev/null

for target in \
  "$PAGARPIX_CONTROLLER_PATH" \
  "$PIX_ROUTER_PATH" \
  "$PIX_ROUTING_V3_PATH"; do
  rel="${target#/app/}"
  docker cp "$EXTRACT/$rel" "$CANDIDATE_CONTAINER:$target"
done

LIVE_AUTH_ROUTES_HOST="$EXTRACT/live-auth.routes.js"
docker cp "$CANDIDATE_CONTAINER:$AUTH_ROUTES_PATH" "$LIVE_AUTH_ROUTES_HOST"
python3 - "$LIVE_AUTH_ROUTES_HOST" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()

if "pagarpix/register" not in text:
    marker = "router.post('/register', ctrl.register);"
    if text.count(marker) != 1:
        raise SystemExit('AUTH_ROUTE_PATCH_MARKER_NOT_UNIQUE')

    replacement = (
        "const pagarpixOnboarding = require(\"../controllers/pagarpix-onboarding.controller\");\n"
        + marker
        + "\nrouter.post('/pagarpix/register', pagarpixOnboarding.registerPagarPix);"
    )
    text = text.replace(marker, replacement, 1)

path.write_text(text)
PY

docker cp "$LIVE_AUTH_ROUTES_HOST" "$CANDIDATE_CONTAINER:$AUTH_ROUTES_PATH"
docker commit "$CANDIDATE_CONTAINER" "$CANDIDATE_IMAGE" >/dev/null

section "5. Candidate syntax and protected-runtime validation"
for target in \
  "$PAGARPIX_CONTROLLER_PATH" \
  "$AUTH_ROUTES_PATH" \
  "$PIX_ROUTER_PATH" \
  "$PIX_ROUTING_V3_PATH"; do
  docker run --rm --entrypoint node "$CANDIDATE_IMAGE" --check "$target" >/dev/null
done

docker run --rm --entrypoint sh "$CANDIDATE_IMAGE" -lc "
  grep -q 'pagarpix/register' '$AUTH_ROUTES_PATH' &&
  grep -q 'pagarpix-onboarding.controller' '$AUTH_ROUTES_PATH' &&
  grep -q 'PagarPIX Conta BRL' '$PAGARPIX_CONTROLLER_PATH' &&
  grep -q 'resolvePixRoutingV3' '$PIX_ROUTER_PATH' &&
  test -f '$PIX_ROUTING_V3_PATH' &&
  grep -q '/api/stripe/v1' '$APP_PATH' &&
  grep -q 'webhooks/misticpay' '$PAYMENTS_ROUTES_PATH'
"

test "$(image_sha "$CANDIDATE_IMAGE" "$AUTH_CONTROLLER_PATH")" = "$AUTH_CONTROLLER_SHA"
test "$(image_sha "$CANDIDATE_IMAGE" "$PIX_CONTROLLER_PATH")" = "$PIX_CONTROLLER_SHA"
test "$(image_sha "$CANDIDATE_IMAGE" "$APP_PATH")" = "$APP_SHA"
test "$(image_sha "$CANDIDATE_IMAGE" "$PAYMENTS_ROUTES_PATH")" = "$PAYMENTS_ROUTES_SHA"
echo "PROTECTED_RUNTIME_SHA=PASS"

if docker run --rm --entrypoint sh "$BASELINE_IMAGE" -lc "grep -q \"'/forgot'\" '$AUTH_ROUTES_PATH'"; then
  docker run --rm --entrypoint sh "$CANDIDATE_IMAGE" -lc "grep -q \"'/forgot'\" '$AUTH_ROUTES_PATH' && grep -q \"'/reset'\" '$AUTH_ROUTES_PATH'"
  echo "PASSWORD_RECOVERY_ROUTES=PRESERVED"
else
  echo "PASSWORD_RECOVERY_ROUTES=NOT_PRESENT_IN_BASELINE"
fi

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
docker exec "$SERVICE" grep -q "pagarpix-onboarding.controller" "$AUTH_ROUTES_PATH"
docker exec "$SERVICE" grep -q "PagarPIX Conta BRL" "$PAGARPIX_CONTROLLER_PATH"
docker exec "$SERVICE" grep -q "resolvePixRoutingV3" "$PIX_ROUTER_PATH"
docker exec "$SERVICE" test -f "$PIX_ROUTING_V3_PATH"
docker exec "$SERVICE" grep -q "/api/stripe/v1" "$APP_PATH"
docker exec "$SERVICE" grep -q "webhooks/misticpay" "$PAYMENTS_ROUTES_PATH"

test "$(docker exec "$SERVICE" sha256sum "$AUTH_CONTROLLER_PATH" | awk '{print $1}')" = "$AUTH_CONTROLLER_SHA"
test "$(docker exec "$SERVICE" sha256sum "$PIX_CONTROLLER_PATH" | awk '{print $1}')" = "$PIX_CONTROLLER_SHA"
test "$(docker exec "$SERVICE" sha256sum "$APP_PATH" | awk '{print $1}')" = "$APP_SHA"
test "$(docker exec "$SERVICE" sha256sum "$PAYMENTS_ROUTES_PATH" | awk '{print $1}')" = "$PAYMENTS_ROUTES_SHA"
echo "PROTECTED_RUNTIME_POST_DEPLOY_SHA=PASS"

REGISTER_STATUS="$(curl -sS -o /tmp/pagarpix-register-probe.json -w '%{http_code}' \
  -H 'content-type: application/json' \
  -d '{}' \
  https://api.xpayments.digital/api/v1/auth/pagarpix/register)"
cat /tmp/pagarpix-register-probe.json
echo

test "$REGISTER_STATUS" = "400"
grep -Eq 'INVALID_EMAIL|INVALID_NAME|WEAK_PASSWORD' /tmp/pagarpix-register-probe.json

echo "PAGARPIX_REGISTER_PROBE=PASS"

if docker exec "$SERVICE" grep -q "'/forgot'" "$AUTH_ROUTES_PATH"; then
  FORGOT_STATUS="$(curl -sS -o /tmp/pagarpix-forgot-probe.json -w '%{http_code}' \
    -H 'content-type: application/json' \
    -d '{}' \
    https://api.xpayments.digital/api/v1/auth/forgot)"
  test "$FORGOT_STATUS" = "202"
  echo "PASSWORD_RECOVERY_PROBE=PASS"
fi

curl -fsS --max-time 8 https://api.xpayments.digital/api/health
echo

section "8. Deployment result"
echo "DEPLOY_STATUS=PASS"
echo "FEATURE_HEAD=${FEATURE_HEAD}"
echo "BASELINE_IMAGE=${BASELINE_IMAGE}"
echo "CANDIDATE_IMAGE=${CANDIDATE_IMAGE}"
echo "ROLLBACK_IMAGE=${BASELINE_IMAGE}"
if [ "$PIX_CONTROLLER_USES_ROUTER" = "1" ]; then
  echo "ROUTING_V3_SHADOW_OBSERVER=ACTIVE_PATH"
else
  echo "ROUTING_V3_SHADOW_OBSERVER=DORMANT_CONTROLLER_RECONCILIATION_REQUIRED"
fi

echo
echo "NOTE: Routing V3 remains observer-only; real provider selection is still Store.routingRules.pix."

DEPLOY_STARTED=0
