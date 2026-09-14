#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="/root/xpayments-backend-v3"
SOURCE_BRANCH="feat/control-plane-v2-live-ops-20260909"
SOURCE_COMMIT="84c83348636a3a327eb2bf3209cc2ea65758de73"
SERVICE="xpayments-api-v3"
CANONICAL_NAME="xpayments-api-v3"

CP_ROUTES="/app/dist/modules/control-plane/routes/control-plane.routes.js"
CP_MIDDLEWARE="/app/dist/modules/control-plane/middleware/control-plane-auth.middleware.js"
CP_TREASURY="/app/dist/modules/control-plane/controllers/control-plane-treasury.controller.js"
CP_ACCOUNTING="/app/dist/modules/control-plane/controllers/control-plane-accounting-wallets.controller.js"
CP_SETTLEMENT="/app/dist/modules/control-plane/controllers/control-plane-treasury-settlement.controller.js"
CP_PUBLIC_ROUTES="/app/dist/modules/control-plane/routes/control-plane-public.routes.js"
APP_PATH="/app/dist/core/app.js"

DIRECT_PATH="/app/dist/modules/payments/controllers/direct.controller.js"
PIX_PATH="/app/dist/modules/payments/controllers/pix.controller.js"
PIX_SERVICE_PATH="/app/dist/modules/payments/services/misticpay.service.js"
WEBHOOK_PATH="/app/dist/modules/payments/controllers/misticpay.webhook.js"
PAYMENTS_ROUTES_PATH="/app/dist/modules/payments/routes/payments.routes.js"

EXPECTED_DIRECT="9a1b097a929519d68caf66c2bb804519af1cdc7e2823208aa3e12daea7571874"
EXPECTED_PIX="3f5ef483e822294a431ae444d3408413095e128fb2b69fa580850d36ab5d0001"
EXPECTED_PIX_SERVICE="30cfd72e457b092185931c9a338326e3aff2edb84d2ad1f9bee46955fc55862d"
EXPECTED_WEBHOOK="b22fd255abe853f269d10068e3802805e72882671a1ade530952582f6ad66901"
EXPECTED_PAYMENTS_ROUTES="44baadad7f0ce997487dc75a43876979eef34e5dc8c20ed0d0b802bfed145dcb"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORKDIR="/root/.xpayments-control-plane-treasury/${STAMP}"
SOURCE_DIR="${WORKDIR}/source"
BASELINE_IMAGE="xpayments-prod-pre-control-plane-treasury:${STAMP}"
CANDIDATE_IMAGE="xpayments-control-plane-treasury:${STAMP}"
CANDIDATE_CONTAINER="xpayments-control-plane-treasury-candidate-${STAMP}"

mkdir -p "$SOURCE_DIR"

DEPLOY_STARTED=0
SERVICE_IMAGE=""
PRIMARY_CID=""

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
    return 1
  fi
  printf '%s\n' "${matches[0]}"
}

container_name() {
  docker inspect -f '{{.Name}}' "$1" | sed 's#^/##'
}

sha_in() {
  docker exec "$1" sha256sum "$2" | cut -d' ' -f1
}

remove_api_containers() {
  local ids=()
  mapfile -t ids < <(
    docker ps -a --format '{{.ID}} {{.Names}}' \
      | awk '$2 == "xpayments-api-v3" || $2 ~ /_xpayments-api-v3$/ {print $1}'
  )
  if [ "${#ids[@]}" -gt 0 ]; then
    docker rm -f "${ids[@]}" >/dev/null
  fi
}

normalize_name() {
  local cid="$1"
  local current
  current="$(container_name "$cid")"
  if [ "$current" != "$CANONICAL_NAME" ]; then
    if docker inspect "$CANONICAL_NAME" >/dev/null 2>&1; then
      echo "Canonical API name already occupied" >&2
      return 1
    fi
    docker rename "$current" "$CANONICAL_NAME" >/dev/null
  fi
}

wait_local_health() {
  local i
  for i in $(seq 1 40); do
    if curl -fsS --max-time 5 http://127.0.0.1:3001/api/health >/tmp/xpay-cp-health.json 2>/dev/null; then
      cat /tmp/xpay-cp-health.json
      echo
      return 0
    fi
    sleep 1
  done
  return 1
}

start_api() {
  cd "$ROOT"
  docker compose up -d --no-build "$SERVICE" >&2
  local cid=""
  for _ in $(seq 1 30); do
    cid="$(find_primary_api 2>/dev/null || true)"
    if [ -n "$cid" ]; then
      normalize_name "$cid"
      find_primary_api
      return 0
    fi
    sleep 1
  done
  return 1
}

outside_hash() {
  local image="$1"
  docker run --rm --entrypoint sh "$image" -lc \
    "find /app/dist -type f \
      ! -path '$CP_ROUTES' \
      ! -path '$CP_MIDDLEWARE' \
      ! -path '$CP_TREASURY' \
      ! -path '$CP_ACCOUNTING' \
      ! -path '$CP_SETTLEMENT' \
      -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1"
}

rollback() {
  local rc="$?"
  set +e
  docker rm -f "$CANDIDATE_CONTAINER" >/dev/null 2>&1 || true
  if [ "$DEPLOY_STARTED" = "1" ] && [ -n "$SERVICE_IMAGE" ]; then
    echo
    echo "ROLLBACK: restoring ${BASELINE_IMAGE}"
    docker tag "$BASELINE_IMAGE" "$SERVICE_IMAGE" || true
    remove_api_containers
    local rollback_cid
    rollback_cid="$(start_api 2>/dev/null || true)"
    if [ -n "$rollback_cid" ]; then
      wait_local_health || true
    fi
  fi
  exit "$rc"
}
trap rollback ERR

section "1. Production preflight"
PRIMARY_CID="$(find_primary_api)"
SERVICE_IMAGE="$(docker inspect -f '{{.Config.Image}}' "$PRIMARY_CID")"

echo "PRIMARY_API_CID=${PRIMARY_CID}"
echo "PRIMARY_API_NAME=$(container_name "$PRIMARY_CID")"
echo "SERVICE_IMAGE=${SERVICE_IMAGE}"

curl -fsS --max-time 8 https://api.xpayments.digital/api/health
echo

# Control Plane V2 must already be mounted in the certified runtime.
docker exec "$PRIMARY_CID" test -f "$CP_ROUTES"
docker exec "$PRIMARY_CID" test -f "$CP_MIDDLEWARE"
docker exec "$PRIMARY_CID" test -f "$CP_PUBLIC_ROUTES"
docker exec "$PRIMARY_CID" sh -lc "grep -q '/api/v1/control-plane' '$APP_PATH'"
echo "CONTROL_PLANE_V2_RUNTIME_PRESENT=PASS"

DIRECT_BEFORE="$(sha_in "$PRIMARY_CID" "$DIRECT_PATH")"
PIX_BEFORE="$(sha_in "$PRIMARY_CID" "$PIX_PATH")"
PIX_SERVICE_BEFORE="$(sha_in "$PRIMARY_CID" "$PIX_SERVICE_PATH")"
WEBHOOK_BEFORE="$(sha_in "$PRIMARY_CID" "$WEBHOOK_PATH")"
PAYMENTS_ROUTES_BEFORE="$(sha_in "$PRIMARY_CID" "$PAYMENTS_ROUTES_PATH")"

test "$DIRECT_BEFORE" = "$EXPECTED_DIRECT"
test "$PIX_BEFORE" = "$EXPECTED_PIX"
test "$PIX_SERVICE_BEFORE" = "$EXPECTED_PIX_SERVICE"
test "$WEBHOOK_BEFORE" = "$EXPECTED_WEBHOOK"
test "$PAYMENTS_ROUTES_BEFORE" = "$EXPECTED_PAYMENTS_ROUTES"

echo "PAYMENT_RUNTIME_PREFLIGHT=PASS"

echo "CP_ROUTES_BEFORE=$(sha_in "$PRIMARY_CID" "$CP_ROUTES")"
echo "CP_MIDDLEWARE_BEFORE=$(sha_in "$PRIMARY_CID" "$CP_MIDDLEWARE")"

section "2. Commit rollback baseline"
docker commit "$PRIMARY_CID" "$BASELINE_IMAGE" >/dev/null
echo "BASELINE_IMAGE=${BASELINE_IMAGE}"

section "3. Export reviewed Control Plane source"
cd "$ROOT"
git fetch origin "$SOURCE_BRANCH" >/dev/null 2>&1
git cat-file -e "${SOURCE_COMMIT}^{commit}"
git archive "$SOURCE_COMMIT" | tar -x -C "$SOURCE_DIR"
echo "SOURCE_COMMIT=${SOURCE_COMMIT}"

section "4. Isolated TypeScript compile"
docker run --rm \
  --entrypoint sh \
  -v "$SOURCE_DIR:/work" \
  -w /work \
  "$BASELINE_IMAGE" \
  -lc '
    set -eu
    ln -s /app/node_modules /work/node_modules
    /app/node_modules/.bin/tsc -p tsconfig.json --outDir dist-hotpatch
    rm /work/node_modules
  '

CP_ROUTES_JS="$SOURCE_DIR/dist-hotpatch/modules/control-plane/routes/control-plane.routes.js"
CP_MIDDLEWARE_JS="$SOURCE_DIR/dist-hotpatch/modules/control-plane/middleware/control-plane-auth.middleware.js"
CP_TREASURY_JS="$SOURCE_DIR/dist-hotpatch/modules/control-plane/controllers/control-plane-treasury.controller.js"
CP_ACCOUNTING_JS="$SOURCE_DIR/dist-hotpatch/modules/control-plane/controllers/control-plane-accounting-wallets.controller.js"
CP_SETTLEMENT_JS="$SOURCE_DIR/dist-hotpatch/modules/control-plane/controllers/control-plane-treasury-settlement.controller.js"

for f in "$CP_ROUTES_JS" "$CP_MIDDLEWARE_JS" "$CP_TREASURY_JS" "$CP_ACCOUNTING_JS" "$CP_SETTLEMENT_JS"; do
  test -f "$f"
  node --check "$f"
done

echo "ISOLATED_COMPILE=PASS"

section "5. Build candidate from current runtime"
docker create --name "$CANDIDATE_CONTAINER" "$BASELINE_IMAGE" >/dev/null

docker cp "$CP_ROUTES_JS" "$CANDIDATE_CONTAINER:$CP_ROUTES"
docker cp "$CP_MIDDLEWARE_JS" "$CANDIDATE_CONTAINER:$CP_MIDDLEWARE"
docker cp "$CP_TREASURY_JS" "$CANDIDATE_CONTAINER:$CP_TREASURY"
docker cp "$CP_ACCOUNTING_JS" "$CANDIDATE_CONTAINER:$CP_ACCOUNTING"
docker cp "$CP_SETTLEMENT_JS" "$CANDIDATE_CONTAINER:$CP_SETTLEMENT"

CP_ROUTES_SHA="$(sha256sum "$CP_ROUTES_JS" | cut -d' ' -f1)"
CP_MIDDLEWARE_SHA="$(sha256sum "$CP_MIDDLEWARE_JS" | cut -d' ' -f1)"
CP_TREASURY_SHA="$(sha256sum "$CP_TREASURY_JS" | cut -d' ' -f1)"
CP_ACCOUNTING_SHA="$(sha256sum "$CP_ACCOUNTING_JS" | cut -d' ' -f1)"
CP_SETTLEMENT_SHA="$(sha256sum "$CP_SETTLEMENT_JS" | cut -d' ' -f1)"

docker commit "$CANDIDATE_CONTAINER" "$CANDIDATE_IMAGE" >/dev/null

echo "CANDIDATE_IMAGE=${CANDIDATE_IMAGE}"
echo "CP_ROUTES_SHA=${CP_ROUTES_SHA}"
echo "CP_MIDDLEWARE_SHA=${CP_MIDDLEWARE_SHA}"
echo "CP_TREASURY_SHA=${CP_TREASURY_SHA}"
echo "CP_ACCOUNTING_SHA=${CP_ACCOUNTING_SHA}"
echo "CP_SETTLEMENT_SHA=${CP_SETTLEMENT_SHA}"

section "6. Candidate isolation"
BASELINE_OUTSIDE_HASH="$(outside_hash "$BASELINE_IMAGE")"
CANDIDATE_OUTSIDE_HASH="$(outside_hash "$CANDIDATE_IMAGE")"
echo "BASELINE_OUTSIDE_HASH=${BASELINE_OUTSIDE_HASH}"
echo "CANDIDATE_OUTSIDE_HASH=${CANDIDATE_OUTSIDE_HASH}"
test "$BASELINE_OUTSIDE_HASH" = "$CANDIDATE_OUTSIDE_HASH"
echo "OUTSIDE_TARGET_DIST_UNCHANGED=PASS"

docker rm -f "$CANDIDATE_CONTAINER" >/dev/null 2>&1 || true

section "7. Deploy candidate"
DEPLOY_STARTED=1
docker tag "$CANDIDATE_IMAGE" "$SERVICE_IMAGE"
remove_api_containers
NEW_CID="$(start_api)"
echo "NEW_PRIMARY_API_CID=${NEW_CID}"
echo "NEW_PRIMARY_API_NAME=$(container_name "$NEW_CID")"
wait_local_health

section "8. Runtime integrity"
test "$(sha_in "$NEW_CID" "$DIRECT_PATH")" = "$DIRECT_BEFORE"
test "$(sha_in "$NEW_CID" "$PIX_PATH")" = "$PIX_BEFORE"
test "$(sha_in "$NEW_CID" "$PIX_SERVICE_PATH")" = "$PIX_SERVICE_BEFORE"
test "$(sha_in "$NEW_CID" "$WEBHOOK_PATH")" = "$WEBHOOK_BEFORE"
test "$(sha_in "$NEW_CID" "$PAYMENTS_ROUTES_PATH")" = "$PAYMENTS_ROUTES_BEFORE"

test "$(sha_in "$NEW_CID" "$CP_ROUTES")" = "$CP_ROUTES_SHA"
test "$(sha_in "$NEW_CID" "$CP_MIDDLEWARE")" = "$CP_MIDDLEWARE_SHA"
test "$(sha_in "$NEW_CID" "$CP_TREASURY")" = "$CP_TREASURY_SHA"
test "$(sha_in "$NEW_CID" "$CP_ACCOUNTING")" = "$CP_ACCOUNTING_SHA"
test "$(sha_in "$NEW_CID" "$CP_SETTLEMENT")" = "$CP_SETTLEMENT_SHA"

echo "PAYMENT_RUNTIME_UNCHANGED=PASS"
echo "CONTROL_PLANE_TREASURY_RUNTIME=PASS"

section "9. Auth boundary smoke test"
HTTP_CODE="$(curl -sS -o /tmp/xpay-cp-treasury-unauth.json -w '%{http_code}' --max-time 8 \
  http://127.0.0.1:3001/api/v1/control-plane/treasury/wallets)"
echo "UNAUTH_TREASURY_HTTP=${HTTP_CODE}"
test "$HTTP_CODE" = "401"
echo "CONTROL_PLANE_AUTH_BOUNDARY=PASS"

section "10. Final public health"
curl -fsS --max-time 8 https://api.xpayments.digital/api/health
echo

DEPLOY_STARTED=0
trap - ERR

echo "CONTROL_PLANE_TREASURY=LIVE"
echo "TREASURY_SETTLEMENT_V2=LIVE"
echo "TREASURY_WRITE_REQUIRES_RBAC=YES"
echo "PAYMENT_CREATED=NO"
echo "SETTLEMENT_EXECUTED=NO"
echo "DEPLOY_RESULT=PASS"
