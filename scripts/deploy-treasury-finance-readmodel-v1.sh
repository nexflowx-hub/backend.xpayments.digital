#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="/root/xpayments-backend-v3"
SOURCE_COMMIT="ad671161036a677ef20647b587abf15bf35e39c5"
SERVICE="xpayments-api-v3"
CANONICAL_NAME="xpayments-api-v3"

TREASURY_TARGET="/app/dist/modules/treasury/controllers/treasury.controller.js"
RELEASES_TARGET="/app/dist/modules/finance/controllers/finance-releases-v2.controller.js"
FINANCE_ROUTES_TARGET="/app/dist/modules/finance/routes/finance.routes.js"

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
WORKDIR="/root/.xpayments-treasury-finance-readmodel/${STAMP}"
SOURCE_DIR="${WORKDIR}/source"
BASELINE_IMAGE="xpayments-prod-pre-treasury-finance-readmodel:${STAMP}"
CANDIDATE_IMAGE="xpayments-treasury-finance-readmodel:${STAMP}"
CANDIDATE_CONTAINER="xpayments-treasury-finance-candidate-${STAMP}"

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
    docker rename "$current" "$CANONICAL_NAME"
  fi
}

wait_local_health() {
  local i
  for i in $(seq 1 40); do
    if curl -fsS --max-time 5 http://127.0.0.1:3001/api/health >/tmp/xpay-treasury-health.json 2>/dev/null; then
      cat /tmp/xpay-treasury-health.json
      echo
      return 0
    fi
    sleep 1
  done
  return 1
}

start_api() {
  cd "$ROOT"
  # Keep command-substitution stdout deterministic: Compose lifecycle output
  # goes to stderr and this function prints only the resolved API CID.
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
      ! -path '$TREASURY_TARGET' \
      ! -path '$RELEASES_TARGET' \
      ! -path '$FINANCE_ROUTES_TARGET' \
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

DIRECT_BEFORE="$(sha_in "$PRIMARY_CID" "$DIRECT_PATH")"
PIX_BEFORE="$(sha_in "$PRIMARY_CID" "$PIX_PATH")"
PIX_SERVICE_BEFORE="$(sha_in "$PRIMARY_CID" "$PIX_SERVICE_PATH")"
WEBHOOK_BEFORE="$(sha_in "$PRIMARY_CID" "$WEBHOOK_PATH")"
PAYMENTS_ROUTES_BEFORE="$(sha_in "$PRIMARY_CID" "$PAYMENTS_ROUTES_PATH")"

echo "DIRECT_RUNTIME_SHA=${DIRECT_BEFORE}"
echo "PIX_RUNTIME_SHA=${PIX_BEFORE}"
echo "PIX_SERVICE_RUNTIME_SHA=${PIX_SERVICE_BEFORE}"
echo "PIX_WEBHOOK_RUNTIME_SHA=${WEBHOOK_BEFORE}"
echo "PAYMENTS_ROUTES_RUNTIME_SHA=${PAYMENTS_ROUTES_BEFORE}"

test "$DIRECT_BEFORE" = "$EXPECTED_DIRECT"
test "$PIX_BEFORE" = "$EXPECTED_PIX"
test "$PIX_SERVICE_BEFORE" = "$EXPECTED_PIX_SERVICE"
test "$WEBHOOK_BEFORE" = "$EXPECTED_WEBHOOK"
test "$PAYMENTS_ROUTES_BEFORE" = "$EXPECTED_PAYMENTS_ROUTES"

echo "PAYMENT_RUNTIME_PREFLIGHT=PASS"

section "2. Commit rollback baseline"
docker commit "$PRIMARY_CID" "$BASELINE_IMAGE" >/dev/null
echo "BASELINE_IMAGE=${BASELINE_IMAGE}"

section "3. Export exact reviewed source"
cd "$ROOT"
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

TREASURY_JS="$SOURCE_DIR/dist-hotpatch/modules/treasury/controllers/treasury.controller.js"
RELEASES_JS="$SOURCE_DIR/dist-hotpatch/modules/finance/controllers/finance-releases-v2.controller.js"
FINANCE_ROUTES_JS="$SOURCE_DIR/dist-hotpatch/modules/finance/routes/finance.routes.js"

test -f "$TREASURY_JS"
test -f "$RELEASES_JS"
test -f "$FINANCE_ROUTES_JS"

node --check "$TREASURY_JS"
node --check "$RELEASES_JS"
node --check "$FINANCE_ROUTES_JS"

echo "ISOLATED_COMPILE=PASS"

section "5. Build candidate from current runtime"
docker create --name "$CANDIDATE_CONTAINER" "$BASELINE_IMAGE" >/dev/null

docker cp "$TREASURY_JS" "$CANDIDATE_CONTAINER:$TREASURY_TARGET"
docker cp "$RELEASES_JS" "$CANDIDATE_CONTAINER:$RELEASES_TARGET"
docker cp "$FINANCE_ROUTES_JS" "$CANDIDATE_CONTAINER:$FINANCE_ROUTES_TARGET"

TREASURY_SHA="$(sha256sum "$TREASURY_JS" | cut -d' ' -f1)"
RELEASES_SHA="$(sha256sum "$RELEASES_JS" | cut -d' ' -f1)"
FINANCE_ROUTES_SHA="$(sha256sum "$FINANCE_ROUTES_JS" | cut -d' ' -f1)"

echo "CANDIDATE_TREASURY_SHA=${TREASURY_SHA}"
echo "CANDIDATE_RELEASES_SHA=${RELEASES_SHA}"
echo "CANDIDATE_FINANCE_ROUTES_SHA=${FINANCE_ROUTES_SHA}"

docker commit "$CANDIDATE_CONTAINER" "$CANDIDATE_IMAGE" >/dev/null

echo "CANDIDATE_IMAGE=${CANDIDATE_IMAGE}"

section "6. Candidate isolation"
BASELINE_OUTSIDE_HASH="$(outside_hash "$BASELINE_IMAGE")"
CANDIDATE_OUTSIDE_HASH="$(outside_hash "$CANDIDATE_IMAGE")"

echo "BASELINE_OUTSIDE_HASH=${BASELINE_OUTSIDE_HASH}"
echo "CANDIDATE_OUTSIDE_HASH=${CANDIDATE_OUTSIDE_HASH}"

test "$BASELINE_OUTSIDE_HASH" = "$CANDIDATE_OUTSIDE_HASH"
echo "OUTSIDE_TARGET_DIST_UNCHANGED=PASS"

# Remove the temporary container before Compose sees inherited service labels.
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
DIRECT_AFTER="$(sha_in "$NEW_CID" "$DIRECT_PATH")"
PIX_AFTER="$(sha_in "$NEW_CID" "$PIX_PATH")"
PIX_SERVICE_AFTER="$(sha_in "$NEW_CID" "$PIX_SERVICE_PATH")"
WEBHOOK_AFTER="$(sha_in "$NEW_CID" "$WEBHOOK_PATH")"
PAYMENTS_ROUTES_AFTER="$(sha_in "$NEW_CID" "$PAYMENTS_ROUTES_PATH")"

test "$DIRECT_AFTER" = "$EXPECTED_DIRECT"
test "$PIX_AFTER" = "$EXPECTED_PIX"
test "$PIX_SERVICE_AFTER" = "$EXPECTED_PIX_SERVICE"
test "$WEBHOOK_AFTER" = "$EXPECTED_WEBHOOK"
test "$PAYMENTS_ROUTES_AFTER" = "$EXPECTED_PAYMENTS_ROUTES"

test "$(sha_in "$NEW_CID" "$TREASURY_TARGET")" = "$TREASURY_SHA"
test "$(sha_in "$NEW_CID" "$RELEASES_TARGET")" = "$RELEASES_SHA"
test "$(sha_in "$NEW_CID" "$FINANCE_ROUTES_TARGET")" = "$FINANCE_ROUTES_SHA"

echo "PAYMENT_RUNTIME_UNCHANGED=PASS"
echo "TREASURY_FINANCE_RUNTIME=PASS"

section "9. Final public health"
curl -fsS --max-time 8 https://api.xpayments.digital/api/health
echo

DEPLOY_STARTED=0
trap - ERR

echo "TREASURY_PHYSICAL_WALLETS_API=LIVE"
echo "FINANCE_RELEASES_PROVIDER_STATUS=LIVE"
echo "PAYMENT_CREATED=NO"
echo "LEDGER_MUTATION=NO"
echo "DEPLOY_RESULT=PASS"
