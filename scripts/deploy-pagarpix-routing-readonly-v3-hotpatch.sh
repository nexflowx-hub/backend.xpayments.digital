#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="/root/xpayments-backend-v3"
SERVICE="xpayments-api-v3"
FEATURE_BRANCH="feat/pagarpix-functional-v3-pix-runtime"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORKROOT="/root/.xpayments-pagarpix-routing-v3/${STAMP}"
FEATURE_SRC="${WORKROOT}/feature-src"
EXTRACT="${WORKROOT}/extract"

BASELINE_IMAGE="xpayments-prod-pre-pagarpix-routing-v3:${STAMP}"
FEATURE_IMAGE="xpayments-pagarpix-routing-v3-feature:${STAMP}"
CANDIDATE_IMAGE="xpayments-pagarpix-routing-v3:${STAMP}"
FEATURE_CONTAINER="xpayments-pagarpix-routing-feature-${STAMP}"
CANDIDATE_CONTAINER="xpayments-pagarpix-routing-candidate-${STAMP}"

APP_PATH="/app/dist/core/app.js"
ROUTE_PATH="/app/dist/modules/pagarpix-routing/pagarpix-routing.routes.js"
AUTH_CONTROLLER_PATH="/app/dist/modules/auth/controllers/auth.controller.js"
AUTH_ROUTES_PATH="/app/dist/modules/auth/routes/auth.routes.js"
PAGARPIX_CONTROLLER_PATH="/app/dist/modules/auth/controllers/pagarpix-onboarding.controller.js"
PIX_CONTROLLER_PATH="/app/dist/modules/payments/controllers/pix.controller.js"
PIX_ROUTER_PATH="/app/dist/modules/payments/services/pix-router.service.js"
PIX_ROUTING_V3_PATH="/app/dist/modules/payments/services/pix-routing-v3.service.js"
PAYMENTS_ROUTES_PATH="/app/dist/modules/payments/routes/payments.routes.js"
PAYOUT_STATEMENTS_ROUTES_PATH="/app/dist/modules/payout-statements/routes/payout-statements.routes.js"

DEPLOY_STARTED=0
SERVICE_IMAGE_REF=""
FEATURE_HEAD=""

section(){ echo; echo "======================================================"; echo "$1"; echo "======================================================"; }
cleanup(){ docker rm -f "$FEATURE_CONTAINER" "$CANDIDATE_CONTAINER" >/dev/null 2>&1 || true; if [ -d "$FEATURE_SRC" ]; then git -C "$ROOT" worktree remove --force "$FEATURE_SRC" >/dev/null 2>&1 || true; fi; }
wait_health(){ local i; for i in $(seq 1 45); do if curl -fsS --max-time 5 http://127.0.0.1:3001/api/health >/tmp/xpayments-pagarpix-routing-health.json 2>/dev/null; then cat /tmp/xpayments-pagarpix-routing-health.json; echo; return 0; fi; sleep 1; done; return 1; }
container_sha(){ docker exec "$SERVICE" sha256sum "$1" | awk '{print $1}'; }
image_sha(){ docker run --rm --entrypoint sha256sum "$1" "$2" | awk '{print $1}'; }
rollback(){ local rc="$?"; set +e; echo; echo "DEPLOY_ERROR_RC=${rc}"; if [ "$DEPLOY_STARTED" = "1" ] && [ -n "$SERVICE_IMAGE_REF" ]; then echo "ROLLBACK: restoring ${BASELINE_IMAGE}"; docker tag "$BASELINE_IMAGE" "$SERVICE_IMAGE_REF"; docker rm -f "$SERVICE" >/dev/null 2>&1 || true; cd "$ROOT"; docker compose up -d --no-build "$SERVICE" >/dev/null 2>&1 || true; wait_health || true; fi; cleanup; exit "$rc"; }
trap rollback ERR
trap cleanup EXIT
mkdir -p "$WORKROOT" "$EXTRACT"

section "1. Production preflight"
docker inspect "$SERVICE" >/dev/null
SERVICE_IMAGE_REF="$(docker inspect -f '{{.Config.Image}}' "$SERVICE")"
echo "SERVICE_IMAGE_REF=${SERVICE_IMAGE_REF}"
curl -fsS --max-time 8 https://api.xpayments.digital/api/health; echo
for target in "$APP_PATH" "$AUTH_CONTROLLER_PATH" "$AUTH_ROUTES_PATH" "$PAGARPIX_CONTROLLER_PATH" "$PIX_CONTROLLER_PATH" "$PIX_ROUTER_PATH" "$PIX_ROUTING_V3_PATH" "$PAYMENTS_ROUTES_PATH" "$PAYOUT_STATEMENTS_ROUTES_PATH"; do docker exec "$SERVICE" test -f "$target"; done
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
echo "PRODUCTION_PREFLIGHT=PASS"

section "2. Snapshot exact current production"
docker commit "$SERVICE" "$BASELINE_IMAGE" >/dev/null
echo "BASELINE_IMAGE=${BASELINE_IMAGE}"

section "3. Build immutable routing facade"
git -C "$ROOT" fetch origin "$FEATURE_BRANCH"
git -C "$ROOT" worktree add --detach "$FEATURE_SRC" "origin/$FEATURE_BRANCH"
FEATURE_HEAD="$(git -C "$FEATURE_SRC" rev-parse HEAD)"
echo "FEATURE_HEAD=${FEATURE_HEAD}"
docker build -t "$FEATURE_IMAGE" "$FEATURE_SRC" >/dev/null
docker run --rm --entrypoint sh "$FEATURE_IMAGE" -lc "test -f '$ROUTE_PATH'"
docker create --name "$FEATURE_CONTAINER" "$FEATURE_IMAGE" >/dev/null
rel="${ROUTE_PATH#/app/}"
mkdir -p "$EXTRACT/$(dirname "$rel")"
docker cp "$FEATURE_CONTAINER:$ROUTE_PATH" "$EXTRACT/$rel"
echo "ROUTING_ARTIFACT=PASS"

section "4. Build candidate from live runtime"
docker create --name "$CANDIDATE_CONTAINER" "$BASELINE_IMAGE" >/dev/null
ROUTE_DIR_HOST="$EXTRACT/dist/modules/pagarpix-routing"
test -d "$ROUTE_DIR_HOST"
docker cp "$ROUTE_DIR_HOST" "$CANDIDATE_CONTAINER:/app/dist/modules/"
LIVE_APP_HOST="$EXTRACT/live-app.js"
docker cp "$CANDIDATE_CONTAINER:$APP_PATH" "$LIVE_APP_HOST"
python3 - "$LIVE_APP_HOST" <<'PY'
from pathlib import Path
import sys
path=Path(sys.argv[1]); text=path.read_text()
marker='pagarpix-routing.routes'
mount='api.use(\'/\', require("../modules/pagarpix-routing/pagarpix-routing.routes").default);'
anchor="app.use('/api/v1', api);"
if marker not in text:
    if text.count(anchor) != 1: raise SystemExit('APP_MOUNT_PATCH_ANCHOR_NOT_UNIQUE')
    text=text.replace(anchor,mount+'\n'+anchor,1)
if text.count(marker) != 1: raise SystemExit('APP_ROUTING_ROUTE_MARKER_NOT_UNIQUE')
path.write_text(text)
PY
docker cp "$LIVE_APP_HOST" "$CANDIDATE_CONTAINER:$APP_PATH"
docker commit "$CANDIDATE_CONTAINER" "$CANDIDATE_IMAGE" >/dev/null

section "5. Candidate validation"
docker run --rm --entrypoint node "$CANDIDATE_IMAGE" --check "$APP_PATH" >/dev/null
docker run --rm --entrypoint node "$CANDIDATE_IMAGE" --check "$ROUTE_PATH" >/dev/null
docker run --rm --entrypoint sh "$CANDIDATE_IMAGE" -lc "grep -q 'pagarpix-routing.routes' '$APP_PATH' && grep -q '/api/stripe/v1' '$APP_PATH' && grep -q 'payout-statements' '$APP_PATH' && grep -q 'webhooks/misticpay' '$PAYMENTS_ROUTES_PATH' && grep -q 'pagarpix/register' '$AUTH_ROUTES_PATH' && grep -q \"'/routing/connections'\" '$ROUTE_PATH' && grep -q \"'/routing/policies'\" '$ROUTE_PATH' && grep -q \"'/routing/decisions'\" '$ROUTE_PATH' && ! grep -Eq '\\.(post|put|patch|delete)\\(' '$ROUTE_PATH'"
test "$(image_sha "$CANDIDATE_IMAGE" "$AUTH_CONTROLLER_PATH")" = "$AUTH_CONTROLLER_SHA"
test "$(image_sha "$CANDIDATE_IMAGE" "$AUTH_ROUTES_PATH")" = "$AUTH_ROUTES_SHA"
test "$(image_sha "$CANDIDATE_IMAGE" "$PAGARPIX_CONTROLLER_PATH")" = "$PAGARPIX_CONTROLLER_SHA"
test "$(image_sha "$CANDIDATE_IMAGE" "$PIX_CONTROLLER_PATH")" = "$PIX_CONTROLLER_SHA"
test "$(image_sha "$CANDIDATE_IMAGE" "$PIX_ROUTER_PATH")" = "$PIX_ROUTER_SHA"
test "$(image_sha "$CANDIDATE_IMAGE" "$PIX_ROUTING_V3_PATH")" = "$PIX_ROUTING_V3_SHA"
test "$(image_sha "$CANDIDATE_IMAGE" "$PAYMENTS_ROUTES_PATH")" = "$PAYMENTS_ROUTES_SHA"
test "$(image_sha "$CANDIDATE_IMAGE" "$PAYOUT_STATEMENTS_ROUTES_PATH")" = "$PAYOUT_STATEMENTS_ROUTES_SHA"
echo "PROTECTED_RUNTIME_SHA=PASS"
echo "ROUTING_FACADE_MODE=READ_ONLY"
echo "CANDIDATE_VALIDATION=PASS"

section "6. Deploy candidate"
DEPLOY_STARTED=1
docker tag "$CANDIDATE_IMAGE" "$SERVICE_IMAGE_REF"
docker rm -f "$SERVICE" >/dev/null
cd "$ROOT"
docker compose up -d --no-build "$SERVICE" >/dev/null
wait_health

section "7. Production contract verification"
docker exec "$SERVICE" grep -q 'pagarpix-routing.routes' "$APP_PATH"
docker exec "$SERVICE" grep -q '/api/stripe/v1' "$APP_PATH"
docker exec "$SERVICE" grep -q 'payout-statements' "$APP_PATH"
docker exec "$SERVICE" grep -q 'webhooks/misticpay' "$PAYMENTS_ROUTES_PATH"
docker exec "$SERVICE" grep -q 'pagarpix/register' "$AUTH_ROUTES_PATH"
test "$(container_sha "$AUTH_CONTROLLER_PATH")" = "$AUTH_CONTROLLER_SHA"
test "$(container_sha "$AUTH_ROUTES_PATH")" = "$AUTH_ROUTES_SHA"
test "$(container_sha "$PAGARPIX_CONTROLLER_PATH")" = "$PAGARPIX_CONTROLLER_SHA"
test "$(container_sha "$PIX_CONTROLLER_PATH")" = "$PIX_CONTROLLER_SHA"
test "$(container_sha "$PIX_ROUTER_PATH")" = "$PIX_ROUTER_SHA"
test "$(container_sha "$PIX_ROUTING_V3_PATH")" = "$PIX_ROUTING_V3_SHA"
test "$(container_sha "$PAYMENTS_ROUTES_PATH")" = "$PAYMENTS_ROUTES_SHA"
test "$(container_sha "$PAYOUT_STATEMENTS_ROUTES_PATH")" = "$PAYOUT_STATEMENTS_ROUTES_SHA"
echo "PROTECTED_RUNTIME_POST_DEPLOY_SHA=PASS"
ROUTING_STATUS="$(curl -sS -o /tmp/pagarpix-routing-unauth.json -w '%{http_code}' https://api.xpayments.digital/api/v1/routing/connections)"
echo "ROUTING_UNAUTH_STATUS=${ROUTING_STATUS}"
test "$ROUTING_STATUS" = "401"
REGISTER_STATUS="$(curl -sS -o /tmp/pagarpix-register-probe.json -w '%{http_code}' -H 'content-type: application/json' -d '{}' https://api.xpayments.digital/api/v1/auth/pagarpix/register)"
test "$REGISTER_STATUS" = "400"
grep -Eq 'INVALID_EMAIL|INVALID_NAME|WEAK_PASSWORD' /tmp/pagarpix-register-probe.json
echo "PAGARPIX_REGISTER_PROBE=PASS"
curl -fsS --max-time 8 https://api.xpayments.digital/api/health; echo

section "8. Deployment result"
echo "DEPLOY_STATUS=PASS"
echo "FEATURE_HEAD=${FEATURE_HEAD}"
echo "BASELINE_IMAGE=${BASELINE_IMAGE}"
echo "CANDIDATE_IMAGE=${CANDIDATE_IMAGE}"
echo "ROLLBACK_IMAGE=${BASELINE_IMAGE}"
echo "PAGARPIX_ROUTING=READ_ONLY_MOUNTED"
echo "PAGARPIX_PAYOUTS=MANUAL_TICKET_ONLY"
echo "PIX_PROVIDER_SELECTION=UNCHANGED_STORE_ROUTING_RULES"
DEPLOY_STARTED=0
