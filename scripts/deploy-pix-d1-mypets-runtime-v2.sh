#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="/root/xpayments-backend-v3"
COMPOSE_SERVICE="xpayments-api-v3"
CANONICAL_NAME="xpayments-api-v3"
FEATURE_BRANCH="feat/pix-d1-mypets-20260915"

APP_PATH="/app/dist/core/app.js"
ROUTES_PATH="/app/dist/modules/payments/routes/payments.routes.js"
PIX_PATH="/app/dist/modules/payments/controllers/pix.controller.js"
MISTIC_PATH="/app/dist/modules/payments/services/misticpay.service.js"
PIXGO_SERVICE_PATH="/app/dist/modules/payments/services/pixgo.service.js"
PIXGO_WEBHOOK_PATH="/app/dist/modules/payments/controllers/pixgo.webhook.js"

EXPECTED_APP_SHA="9832a9cda9ba8e287c3f3f8b1630d06916911fc7d9731d3552839810118c232d"
EXPECTED_ROUTES_SHA="44baadad7f0ce997487dc75a43876979eef34e5dc8c20ed0d0b802bfed145dcb"
EXPECTED_PIX_SHA="3f5ef483e822294a431ae444d3408413095e128fb2b69fa580850d36ab5d0001"
EXPECTED_MISTIC_SHA="30cfd72e457b092185931c9a338326e3aff2edb84d2ad1f9bee46955fc55862d"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORKROOT="/root/.xpayments-pix-d1-runtime-v2/${STAMP}"
FEATURE_SRC="${WORKROOT}/feature-src"
EXTRACT="${WORKROOT}/extract"

FEATURE_BUILD_IMAGE="xpayments-pix-d1-feature-build-v2:${STAMP}"
BASELINE_IMAGE="xpayments-prod-pre-pix-d1-v2:${STAMP}"
CANDIDATE_IMAGE="xpayments-pix-d1-runtime-v2:${STAMP}"

FEATURE_CONTAINER="xpayments-pix-d1-feature-v2-${STAMP}"
CANDIDATE_CONTAINER="xpayments-pix-d1-candidate-v2-${STAMP}"

PRIMARY_CID=""
SERVICE_IMAGE_REF=""
DEPLOY_STARTED=0

section() {
  echo
  echo "======================================================"
  echo "$1"
  echo "======================================================"
}

find_primary_api() {
  local matches=()
  mapfile -t matches < <(
    docker ps --format '{{.ID}} {{.Ports}}' \
      | awk '$0 ~ /127\.0\.0\.1:3001->8084\/tcp/ {print $1}'
  )

  if [ "${#matches[@]}" -ne 1 ]; then
    echo "PRIMARY_API_MATCHES=${#matches[@]}" >&2
    docker ps --format 'id={{.ID}} name={{.Names}} status={{.Status}} image={{.Image}} ports={{.Ports}}' >&2
    return 1
  fi

  printf '%s\n' "${matches[0]}"
}

api_name() {
  docker inspect -f '{{.Name}}' "$1" | sed 's#^/##'
}

sha_in() {
  docker exec "$1" sha256sum "$2" | cut -d' ' -f1
}

image_sha() {
  docker run --rm --entrypoint sha256sum "$1" "$2" | cut -d' ' -f1
}

remove_api_containers() {
  local ids=()
  mapfile -t ids < <(
    docker ps -aq --format '{{.ID}} {{.Names}}' \
      | awk '$2 == "xpayments-api-v3" || $2 ~ /_xpayments-api-v3$/ {print $1}'
  )

  if [ "${#ids[@]}" -gt 0 ]; then
    docker rm -f "${ids[@]}" >/dev/null
  fi
}

start_compose_api() {
  cd "$ROOT"
  docker compose up -d --no-build "$COMPOSE_SERVICE"

  local cid=""
  for _ in $(seq 1 30); do
    cid="$(find_primary_api 2>/dev/null || true)"
    if [ -n "$cid" ]; then
      printf '%s\n' "$cid"
      return 0
    fi
    sleep 1
  done

  return 1
}

normalize_name() {
  local cid="$1"
  local current
  current="$(api_name "$cid")"

  if [ "$current" != "$CANONICAL_NAME" ]; then
    if docker inspect "$CANONICAL_NAME" >/dev/null 2>&1; then
      echo "Canonical API name already occupied" >&2
      return 1
    fi
    docker rename "$current" "$CANONICAL_NAME"
  fi
}

wait_health() {
  local i
  for i in $(seq 1 40); do
    if curl -fsS --max-time 5 http://127.0.0.1:3001/api/health >/tmp/xpayments-pix-d1-v2-health.json 2>/dev/null; then
      cat /tmp/xpayments-pix-d1-v2-health.json
      echo
      return 0
    fi
    sleep 1
  done
  return 1
}

outside_hash() {
  local image="$1"
  docker run --rm "$image" sh -lc \
    "find /app/dist -type f \
      ! -path '$APP_PATH' \
      ! -path '$ROUTES_PATH' \
      ! -path '$PIX_PATH' \
      ! -path '$PIXGO_SERVICE_PATH' \
      ! -path '$PIXGO_WEBHOOK_PATH' \
      -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1"
}

cleanup() {
  docker rm -f "$FEATURE_CONTAINER" "$CANDIDATE_CONTAINER" >/dev/null 2>&1 || true

  if [ -d "$FEATURE_SRC" ]; then
    git -C "$ROOT" worktree remove --force "$FEATURE_SRC" >/dev/null 2>&1 || true
  fi
}

rollback() {
  local rc="$?"
  set +e

  echo
  echo "DEPLOY_ERROR_RC=${rc}"

  if [ "$DEPLOY_STARTED" = "1" ] && [ -n "$SERVICE_IMAGE_REF" ]; then
    echo "ROLLBACK: restoring ${BASELINE_IMAGE}"
    docker tag "$BASELINE_IMAGE" "$SERVICE_IMAGE_REF"
    remove_api_containers

    local rollback_cid
    rollback_cid="$(start_compose_api)"
    if [ -n "$rollback_cid" ]; then
      normalize_name "$rollback_cid"
      wait_health
    fi
  fi

  cleanup
  exit "$rc"
}
trap rollback ERR

mkdir -p "$WORKROOT" "$EXTRACT"

section "1. Production preflight"
PRIMARY_CID="$(find_primary_api)"
SERVICE_IMAGE_REF="$(docker inspect -f '{{.Config.Image}}' "$PRIMARY_CID")"

echo "PRIMARY_API_CID=${PRIMARY_CID}"
echo "PRIMARY_API_NAME=$(api_name "$PRIMARY_CID")"
echo "SERVICE_IMAGE_REF=${SERVICE_IMAGE_REF}"

curl -fsS --max-time 8 https://api.xpayments.digital/api/health
echo

APP_SHA="$(sha_in "$PRIMARY_CID" "$APP_PATH")"
ROUTES_SHA="$(sha_in "$PRIMARY_CID" "$ROUTES_PATH")"
PIX_SHA="$(sha_in "$PRIMARY_CID" "$PIX_PATH")"
MISTIC_SHA="$(sha_in "$PRIMARY_CID" "$MISTIC_PATH")"

echo "APP_RUNTIME_SHA=${APP_SHA}"
echo "PAYMENTS_ROUTES_SHA=${ROUTES_SHA}"
echo "PIX_CONTROLLER_SHA=${PIX_SHA}"
echo "LEGACY_PIX_SERVICE_SHA=${MISTIC_SHA}"

test "$APP_SHA" = "$EXPECTED_APP_SHA"
test "$ROUTES_SHA" = "$EXPECTED_ROUTES_SHA"
test "$PIX_SHA" = "$EXPECTED_PIX_SHA"
test "$MISTIC_SHA" = "$EXPECTED_MISTIC_SHA"

docker exec "$PRIMARY_CID" test ! -f "$PIXGO_SERVICE_PATH"
docker exec "$PRIMARY_CID" test ! -f "$PIXGO_WEBHOOK_PATH"

docker exec "$PRIMARY_CID" grep -q "/api/stripe/v1" "$APP_PATH"
docker exec "$PRIMARY_CID" grep -q "webhooks/pix-static" "$ROUTES_PATH"
docker exec "$PRIMARY_CID" grep -q "webhooks/stripe/direct/:slug" "$ROUTES_PATH"

echo "RUNTIME_PREFLIGHT=PASS"
echo "EXISTING_EXTENSIONS_PRESENT=PASS"

section "2. Snapshot exact production runtime"
docker commit "$PRIMARY_CID" "$BASELINE_IMAGE" >/dev/null
echo "BASELINE_IMAGE=${BASELINE_IMAGE}"

section "3. Build feature artifacts"
git -C "$ROOT" fetch origin "$FEATURE_BRANCH"
git -C "$ROOT" worktree add --detach "$FEATURE_SRC" "origin/$FEATURE_BRANCH"
echo "FEATURE_HEAD=$(git -C "$FEATURE_SRC" rev-parse HEAD)"

docker build -t "$FEATURE_BUILD_IMAGE" "$FEATURE_SRC"
docker create --name "$FEATURE_CONTAINER" "$FEATURE_BUILD_IMAGE" >/dev/null

for target in "$PIXGO_SERVICE_PATH" "$PIXGO_WEBHOOK_PATH"; do
  rel="${target#/app/}"
  mkdir -p "$EXTRACT/$(dirname "$rel")"
  docker cp "$FEATURE_CONTAINER:$target" "$EXTRACT/$rel"
done

echo "FEATURE_ARTIFACTS_EXTRACTED=PASS"

section "4. Patch current compiled runtime only"
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

# 1) Preserve raw body for the new signed PIX webhook, without changing
# the existing Stripe-compatible relay or Stripe webhook behavior.
app = app_path.read_text()
old = "if (requestPath === '/api/v1/payments/webhooks/stripe') {"
new = "if (requestPath === '/api/v1/payments/webhooks/stripe' ||\n            requestPath === '/api/v1/payments/webhooks/pix-d1') {"
count = app.count(old)
if count != 1:
    raise SystemExit(f"APP_PATCH_MATCH_COUNT={count}; expected exactly 1")
app = app.replace(old, new, 1)
app_path.write_text(app)
print("APP_PATCH_MATCH_COUNT=1")

# 2) Add the provider-specific inbound webhook route while preserving
# Mistic, static PIX, Stripe and Direct Observer routes byte-for-byte otherwise.
routes = routes_path.read_text()
import_anchor = 'const misticPayWebhook = __importStar(require("../controllers/misticpay.webhook"));'
if routes.count(import_anchor) != 1:
    raise SystemExit(f"ROUTES_IMPORT_MATCH_COUNT={routes.count(import_anchor)}; expected exactly 1")
routes = routes.replace(
    import_anchor,
    import_anchor + '\nconst pixD1Webhook = __importStar(require("../controllers/pixgo.webhook"));',
    1,
)

route_anchor = "router.post('/webhooks/misticpay', misticPayWebhook.handleMisticPayWebhook);"
if routes.count(route_anchor) != 1:
    raise SystemExit(f"ROUTES_HANDLER_MATCH_COUNT={routes.count(route_anchor)}; expected exactly 1")
routes = routes.replace(
    route_anchor,
    route_anchor + "\nrouter.post('/webhooks/pix-d1', pixD1Webhook.handlePixD1Webhook);",
    1,
)
routes_path.write_text(routes)
print("ROUTES_PATCH_MATCH_COUNT=2")

# 3) Extend the existing PIX controller dispatcher. pix-static keeps its
# dedicated service; all legacy/default PIX keeps the current service;
# only the internal pix-d1-* alias reaches the new adapter.
pix = pix_path.read_text()
pix_import_anchor = 'const static_pix_service_1 = require("../services/static-pix.service");'
if pix.count(pix_import_anchor) != 1:
    raise SystemExit(f"PIX_IMPORT_MATCH_COUNT={pix.count(pix_import_anchor)}; expected exactly 1")
pix = pix.replace(
    pix_import_anchor,
    pix_import_anchor + '\nconst pixgo_service_1 = require("../services/pixgo.service");',
    1,
)

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
pix_path.write_text(pix)
print("PIX_DISPATCH_MATCH_COUNT=1")
PY

for target in "$APP_PATH" "$ROUTES_PATH" "$PIX_PATH"; do
  rel="${target#/app/}"
  node --check "$EXTRACT/$rel" >/dev/null
  docker cp "$EXTRACT/$rel" "$CANDIDATE_CONTAINER:$target"
done

for target in "$PIXGO_SERVICE_PATH" "$PIXGO_WEBHOOK_PATH"; do
  rel="${target#/app/}"
  node --check "$EXTRACT/$rel" >/dev/null
  docker cp "$EXTRACT/$rel" "$CANDIDATE_CONTAINER:$target"
done

echo "PATCHED_NODE_SYNTAX=PASS"

section "5. Candidate isolation and feature integrity"
docker commit "$CANDIDATE_CONTAINER" "$CANDIDATE_IMAGE" >/dev/null

BASE_OUTSIDE_HASH="$(outside_hash "$BASELINE_IMAGE")"
CANDIDATE_OUTSIDE_HASH="$(outside_hash "$CANDIDATE_IMAGE")"
echo "BASE_OUTSIDE_HASH=${BASE_OUTSIDE_HASH}"
echo "CANDIDATE_OUTSIDE_HASH=${CANDIDATE_OUTSIDE_HASH}"
test "$BASE_OUTSIDE_HASH" = "$CANDIDATE_OUTSIDE_HASH"

for target in "$PIXGO_SERVICE_PATH" "$PIXGO_WEBHOOK_PATH"; do
  feature="$(image_sha "$FEATURE_BUILD_IMAGE" "$target")"
  candidate="$(image_sha "$CANDIDATE_IMAGE" "$target")"
  echo "NEW_FILE=${target}"
  echo "  FEATURE=${feature}"
  echo "  CANDIDATE=${candidate}"
  test "$feature" = "$candidate"
done

echo "CANDIDATE_ISOLATION=PASS"

section "6. Deploy with deterministic container replacement"
DEPLOY_STARTED=1
docker tag "$CANDIDATE_IMAGE" "$SERVICE_IMAGE_REF"
remove_api_containers
NEW_CID="$(start_compose_api)"
normalize_name "$NEW_CID"
NEW_CID="$(find_primary_api)"

echo "NEW_PRIMARY_API_CID=${NEW_CID}"
echo "NEW_PRIMARY_API_NAME=$(api_name "$NEW_CID")"
wait_health

section "7. Runtime integrity"
NEW_APP_SHA="$(sha_in "$NEW_CID" "$APP_PATH")"
NEW_ROUTES_SHA="$(sha_in "$NEW_CID" "$ROUTES_PATH")"
NEW_PIX_SHA="$(sha_in "$NEW_CID" "$PIX_PATH")"
MISTIC_AFTER="$(sha_in "$NEW_CID" "$MISTIC_PATH")"

PATCHED_APP_SHA="$(sha256sum "$EXTRACT/${APP_PATH#/app/}" | cut -d' ' -f1)"
PATCHED_ROUTES_SHA="$(sha256sum "$EXTRACT/${ROUTES_PATH#/app/}" | cut -d' ' -f1)"
PATCHED_PIX_SHA="$(sha256sum "$EXTRACT/${PIX_PATH#/app/}" | cut -d' ' -f1)"

test "$NEW_APP_SHA" = "$PATCHED_APP_SHA"
test "$NEW_ROUTES_SHA" = "$PATCHED_ROUTES_SHA"
test "$NEW_PIX_SHA" = "$PATCHED_PIX_SHA"
test "$MISTIC_AFTER" = "$EXPECTED_MISTIC_SHA"

for target in "$PIXGO_SERVICE_PATH" "$PIXGO_WEBHOOK_PATH"; do
  runtime="$(sha_in "$NEW_CID" "$target")"
  feature="$(image_sha "$FEATURE_BUILD_IMAGE" "$target")"
  test "$runtime" = "$feature"
done

docker exec "$NEW_CID" grep -q "/api/stripe/v1" "$APP_PATH"
docker exec "$NEW_CID" grep -q "webhooks/pix-static" "$ROUTES_PATH"
docker exec "$NEW_CID" grep -q "webhooks/stripe/direct/:slug" "$ROUTES_PATH"
docker exec "$NEW_CID" grep -q "webhooks/pix-d1" "$ROUTES_PATH"
docker exec "$NEW_CID" grep -q "pix-d1" "$PIX_PATH"

echo "LEGACY_PIX_SERVICE_UNCHANGED=PASS"
echo "EXISTING_EXTENSIONS_PRESERVED=PASS"
echo "PIX_D1_RUNTIME_PRESENT=PASS"

section "8. Webhook route smoke test"
WEBHOOK_HTTP="$(curl -sS -o /tmp/xpayments-pix-d1-v2-webhook.json -w '%{http_code}' \
  -X POST \
  -H 'Content-Type: application/json' \
  -d '{}' \
  https://api.xpayments.digital/api/v1/payments/webhooks/pix-d1)"
cat /tmp/xpayments-pix-d1-v2-webhook.json
echo
echo "WEBHOOK_HTTP=${WEBHOOK_HTTP}"
test "$WEBHOOK_HTTP" = "400"

section "9. Final health"
curl -fsS --max-time 8 https://api.xpayments.digital/api/health
echo

DEPLOY_STARTED=0
cleanup

echo "PIX_D1_RUNTIME_V2_DEPLOY=PASS"
echo "ROUTING_CHANGED=NO"
echo "SAFE_TO_ACTIVATE_MYPETS=YES"
echo "BASELINE_IMAGE=${BASELINE_IMAGE}"
echo "CANDIDATE_IMAGE=${CANDIDATE_IMAGE}"
