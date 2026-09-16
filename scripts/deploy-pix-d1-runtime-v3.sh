#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="/root/xpayments-backend-v3"
SERVICE="xpayments-api-v3"
FEATURE_BRANCH="feat/pix-d1-mypets-20260915"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORKROOT="/root/.xpayments-pix-d1-runtime-v3/${STAMP}"
FEATURE_SRC="${WORKROOT}/feature-src"
EXTRACT="${WORKROOT}/extract"

BASELINE_IMAGE="xpayments-prod-pre-pix-d1-v3:${STAMP}"
FEATURE_IMAGE="xpayments-pix-d1-feature-v3:${STAMP}"
CANDIDATE_IMAGE="xpayments-pix-d1-runtime-v3:${STAMP}"
FEATURE_CONTAINER="xpayments-pix-d1-feature-v3-${STAMP}"
CANDIDATE_CONTAINER="xpayments-pix-d1-candidate-v3-${STAMP}"

APP_PATH="/app/dist/core/app.js"
ROUTES_PATH="/app/dist/modules/payments/routes/payments.routes.js"
PIX_PATH="/app/dist/modules/payments/controllers/pix.controller.js"
MISTIC_PATH="/app/dist/modules/payments/services/misticpay.service.js"
PIXGO_SERVICE_PATH="/app/dist/modules/payments/services/pixgo.service.js"
PIXGO_WEBHOOK_PATH="/app/dist/modules/payments/controllers/pixgo.webhook.js"

DEPLOY_STARTED=0
SERVICE_IMAGE_REF=""
BASE_MISTIC_SHA=""

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
  for i in $(seq 1 40); do
    if curl -fsS --max-time 5 http://127.0.0.1:3001/api/health >/tmp/xpayments-pix-d1-v3-health.json 2>/dev/null; then
      cat /tmp/xpayments-pix-d1-v3-health.json
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

mkdir -p "$WORKROOT" "$EXTRACT"

section "1. Production preflight"
docker inspect "$SERVICE" >/dev/null
SERVICE_IMAGE_REF="$(docker inspect -f '{{.Config.Image}}' "$SERVICE")"
echo "SERVICE_IMAGE_REF=${SERVICE_IMAGE_REF}"

curl -fsS --max-time 8 https://api.xpayments.digital/api/health
echo

for target in "$APP_PATH" "$ROUTES_PATH" "$PIX_PATH" "$MISTIC_PATH"; do
  docker exec "$SERVICE" test -f "$target"
  echo "$(docker exec "$SERVICE" sha256sum "$target")"
done

BASE_MISTIC_SHA="$(docker exec "$SERVICE" sha256sum "$MISTIC_PATH" | awk '{print $1}')"

docker exec "$SERVICE" grep -q "/api/stripe/v1" "$APP_PATH"
docker exec "$SERVICE" grep -q "webhooks/pix-static" "$ROUTES_PATH"
docker exec "$SERVICE" grep -q "webhooks/stripe/direct/:slug" "$ROUTES_PATH"

echo "PRODUCTION_PREFLIGHT=PASS"

section "2. Snapshot exact current production"
docker commit "$SERVICE" "$BASELINE_IMAGE" >/dev/null
echo "BASELINE_IMAGE=${BASELINE_IMAGE}"

section "3. Build canonical D1 feature artifacts"
git -C "$ROOT" fetch origin "$FEATURE_BRANCH"
git -C "$ROOT" worktree add --detach "$FEATURE_SRC" "origin/$FEATURE_BRANCH"
echo "FEATURE_HEAD=$(git -C "$FEATURE_SRC" rev-parse HEAD)"
docker build -t "$FEATURE_IMAGE" "$FEATURE_SRC" >/dev/null
docker create --name "$FEATURE_CONTAINER" "$FEATURE_IMAGE" >/dev/null

for target in "$PIXGO_SERVICE_PATH" "$PIXGO_WEBHOOK_PATH"; do
  rel="${target#/app/}"
  mkdir -p "$EXTRACT/$(dirname "$rel")"
  docker cp "$FEATURE_CONTAINER:$target" "$EXTRACT/$rel"
done

echo "FEATURE_ARTIFACTS=PASS"

section "4. Create candidate from live runtime"
docker create --name "$CANDIDATE_CONTAINER" "$BASELINE_IMAGE" >/dev/null

for target in "$APP_PATH" "$ROUTES_PATH" "$PIX_PATH"; do
  rel="${target#/app/}"
  mkdir -p "$EXTRACT/$(dirname "$rel")"
  docker cp "$CANDIDATE_CONTAINER:$target" "$EXTRACT/$rel"
done

python3 - \
  "$EXTRACT/${APP_PATH#/app/}" \
  "$EXTRACT/${ROUTES_PATH#/app/}" \
  "$EXTRACT/${PIX_PATH#/app/}" <<'PY'
from pathlib import Path
import re
import sys

app_path = Path(sys.argv[1])
routes_path = Path(sys.argv[2])
pix_path = Path(sys.argv[3])

app = app_path.read_text()
if "/api/v1/payments/webhooks/pix-d1" not in app:
    old = "if (requestPath === '/api/v1/payments/webhooks/stripe') {"
    new = "if (requestPath === '/api/v1/payments/webhooks/stripe' ||\n            requestPath === '/api/v1/payments/webhooks/pix-d1') {"
    count = app.count(old)
    if count != 1:
        raise SystemExit(f"APP_PATCH_MATCH_COUNT={count}; expected exactly 1")
    app = app.replace(old, new, 1)
    print("APP_PATCH=APPLIED")
else:
    print("APP_PATCH=ALREADY_PRESENT")
app_path.write_text(app)

routes = routes_path.read_text()
import_line = 'const pixD1Webhook = __importStar(require("../controllers/pixgo.webhook"));'
if import_line not in routes:
    anchor = 'const misticPayWebhook = __importStar(require("../controllers/misticpay.webhook"));'
    count = routes.count(anchor)
    if count != 1:
        raise SystemExit(f"ROUTES_IMPORT_MATCH_COUNT={count}; expected exactly 1")
    routes = routes.replace(anchor, anchor + '\n' + import_line, 1)
    print("ROUTES_IMPORT_PATCH=APPLIED")
else:
    print("ROUTES_IMPORT_PATCH=ALREADY_PRESENT")

route_line = "router.post('/webhooks/pix-d1', pixD1Webhook.handlePixD1Webhook);"
if route_line not in routes:
    anchor = "router.post('/webhooks/misticpay', misticPayWebhook.handleMisticPayWebhook);"
    count = routes.count(anchor)
    if count != 1:
        raise SystemExit(f"ROUTES_HANDLER_MATCH_COUNT={count}; expected exactly 1")
    routes = routes.replace(anchor, anchor + '\n' + route_line, 1)
    print("ROUTES_HANDLER_PATCH=APPLIED")
else:
    print("ROUTES_HANDLER_PATCH=ALREADY_PRESENT")
routes_path.write_text(routes)

pix = pix_path.read_text()
require_line = 'const pixgo_service_1 = require("../services/pixgo.service");'
if require_line not in pix:
    anchor = 'const static_pix_service_1 = require("../services/static-pix.service");'
    count = pix.count(anchor)
    if count != 1:
        raise SystemExit(f"PIX_IMPORT_MATCH_COUNT={count}; expected exactly 1")
    pix = pix.replace(anchor, anchor + '\n' + require_line, 1)
    print("PIX_IMPORT_PATCH=APPLIED")
else:
    print("PIX_IMPORT_PATCH=ALREADY_PRESENT")

if "pixProvider.startsWith('pix-d1')" not in pix:
    pattern = re.compile(
        r"const result = pixProvider ===\s*'pix-static'\s*"
        r"\? await \(0, static_pix_service_1\.executeStaticPixPayment\)\(paymentInput\)\s*"
        r": await \(0, misticpay_service_1\.executePixPayment\)\(paymentInput\);",
        re.MULTILINE,
    )
    replacement = (
        "const result = pixProvider.startsWith('pix-d1')\n"
        "            ? await (0, pixgo_service_1.executePixD1Payment)(paymentInput)\n"
        "            : pixProvider === 'pix-static'\n"
        "                ? await (0, static_pix_service_1.executeStaticPixPayment)(paymentInput)\n"
        "                : await (0, misticpay_service_1.executePixPayment)(paymentInput);"
    )
    pix, count = pattern.subn(replacement, pix)
    if count != 1:
        raise SystemExit(f"PIX_DISPATCH_MATCH_COUNT={count}; expected exactly 1")
    print("PIX_DISPATCH_PATCH=APPLIED")
else:
    print("PIX_DISPATCH_PATCH=ALREADY_PRESENT")
pix_path.write_text(pix)
PY

for target in "$APP_PATH" "$ROUTES_PATH" "$PIX_PATH"; do
  rel="${target#/app/}"
  docker cp "$EXTRACT/$rel" "$CANDIDATE_CONTAINER:$target"
done

for target in "$PIXGO_SERVICE_PATH" "$PIXGO_WEBHOOK_PATH"; do
  rel="${target#/app/}"
  docker cp "$EXTRACT/$rel" "$CANDIDATE_CONTAINER:$target"
done

section "5. Candidate validation"
for target in "$APP_PATH" "$ROUTES_PATH" "$PIX_PATH" "$PIXGO_SERVICE_PATH" "$PIXGO_WEBHOOK_PATH"; do
  docker start "$CANDIDATE_CONTAINER" >/dev/null 2>&1 || true
  docker exec "$CANDIDATE_CONTAINER" node --check "$target" >/dev/null
  docker stop "$CANDIDATE_CONTAINER" >/dev/null 2>&1 || true
done

docker commit "$CANDIDATE_CONTAINER" "$CANDIDATE_IMAGE" >/dev/null

MISTIC_CANDIDATE_SHA="$(docker run --rm --entrypoint sha256sum "$CANDIDATE_IMAGE" "$MISTIC_PATH" | awk '{print $1}')"
test "$MISTIC_CANDIDATE_SHA" = "$BASE_MISTIC_SHA"

docker run --rm "$CANDIDATE_IMAGE" sh -lc "
  test -f '$PIXGO_SERVICE_PATH' &&
  test -f '$PIXGO_WEBHOOK_PATH' &&
  grep -q \"pixProvider.startsWith('pix-d1')\" '$PIX_PATH' &&
  grep -q 'webhooks/pix-d1' '$ROUTES_PATH' &&
  grep -q '/api/v1/payments/webhooks/pix-d1' '$APP_PATH' &&
  grep -q '/api/stripe/v1' '$APP_PATH' &&
  grep -q 'webhooks/pix-static' '$ROUTES_PATH' &&
  grep -q 'webhooks/stripe/direct/:slug' '$ROUTES_PATH'
"

echo "CANDIDATE_VALIDATION=PASS"
echo "LEGACY_PIX_SERVICE_UNCHANGED=PASS"
echo "EXISTING_EXTENSIONS_PRESERVED=PASS"

section "6. Deploy candidate"
DEPLOY_STARTED=1
docker tag "$CANDIDATE_IMAGE" "$SERVICE_IMAGE_REF"
docker rm -f "$SERVICE" >/dev/null
cd "$ROOT"
docker compose up -d --no-build "$SERVICE" >/dev/null
wait_health

section "7. Runtime verification"
docker exec "$SERVICE" test -f "$PIXGO_SERVICE_PATH"
docker exec "$SERVICE" test -f "$PIXGO_WEBHOOK_PATH"
docker exec "$SERVICE" grep -q "pixProvider.startsWith('pix-d1')" "$PIX_PATH"
docker exec "$SERVICE" grep -q "webhooks/pix-d1" "$ROUTES_PATH"
docker exec "$SERVICE" grep -q "/api/v1/payments/webhooks/pix-d1" "$APP_PATH"
docker exec "$SERVICE" grep -q "/api/stripe/v1" "$APP_PATH"
docker exec "$SERVICE" grep -q "webhooks/pix-static" "$ROUTES_PATH"
docker exec "$SERVICE" grep -q "webhooks/stripe/direct/:slug" "$ROUTES_PATH"

MISTIC_AFTER_SHA="$(docker exec "$SERVICE" sha256sum "$MISTIC_PATH" | awk '{print $1}')"
test "$MISTIC_AFTER_SHA" = "$BASE_MISTIC_SHA"

echo "RUNTIME_FILES=PASS"
echo "LEGACY_PIX_SERVICE_UNCHANGED=PASS"
echo "EXISTING_EXTENSIONS_PRESERVED=PASS"

section "8. Webhook smoke"
WEBHOOK_HTTP="$(curl -sS -o /tmp/xpayments-pix-d1-v3-webhook.json -w '%{http_code}' \
  -X POST \
  -H 'Content-Type: application/json' \
  -d '{}' \
  https://api.xpayments.digital/api/v1/payments/webhooks/pix-d1)"
cat /tmp/xpayments-pix-d1-v3-webhook.json
echo
echo "WEBHOOK_HTTP=${WEBHOOK_HTTP}"
test "$WEBHOOK_HTTP" = "400"

section "9. Final health"
curl -fsS --max-time 8 https://api.xpayments.digital/api/health
echo

DEPLOY_STARTED=0
cleanup

echo

echo "PIX_D1_RUNTIME_V3_DEPLOY=PASS"
echo "ROUTING_CHANGED=NO"
echo "SAFE_TO_ACTIVATE_TWT=YES"
echo "BASELINE_IMAGE=${BASELINE_IMAGE}"
echo "CANDIDATE_IMAGE=${CANDIDATE_IMAGE}"
