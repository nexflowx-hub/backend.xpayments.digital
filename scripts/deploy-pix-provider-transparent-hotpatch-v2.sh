#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="/root/xpayments-backend-v3"
CONTAINER="xpayments-api-v3"
COMPOSE_SERVICE="xpayments-api-v3"
TARGET="/app/dist/modules/payments/services/misticpay.service.js"
DIRECT_PATH="/app/dist/modules/payments/controllers/direct.controller.js"
PIX_PATH="/app/dist/modules/payments/controllers/pix.controller.js"
ROUTES_PATH="/app/dist/modules/payments/routes/payments.routes.js"

EXPECTED_DIRECT_SHA="9a1b097a929519d68caf66c2bb804519af1cdc7e2823208aa3e12daea7571874"
EXPECTED_PIX_SHA="3f5ef483e822294a431ae444d3408413095e128fb2b69fa580850d36ab5d0001"
EXPECTED_MISTIC_SHA="9b9a8264a0af7598160643bd2fcb357b0da3d04d826c9f3ec7d05c81187a3cc6"
EXPECTED_WEBHOOK_SHA="b22fd255abe853f269d10068e3802805e72882671a1ade530952582f6ad66901"
EXPECTED_ROUTES_SHA="44baadad7f0ce997487dc75a43876979eef34e5dc8c20ed0d0b802bfed145dcb"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BASELINE_IMAGE="xpayments-prod-pre-pix-provider-transparent:${STAMP}"
CANDIDATE_IMAGE="xpayments-pix-provider-transparent:${STAMP}"
BUILD_CONTAINER="xpayments-pix-provider-transparent-build-${STAMP}"
WORKDIR="/root/.xpayments-pix-provider-transparent/${STAMP}"
mkdir -p "$WORKDIR"

DEPLOY_STARTED=0
SERVICE_IMAGE_REF=""

section() {
  echo
  echo "======================================================"
  echo "$1"
  echo "======================================================"
}

sha_in_container() {
  docker exec "$CONTAINER" sha256sum "$1" | awk '{print $1}'
}

resolve_webhook_path() {
  local candidates=(
    "/app/dist/modules/payments/controllers/misticpay.webhook.js"
    "/app/dist/modules/payments/controllers/misticpay-webhook.controller.js"
  )
  local p
  for p in "${candidates[@]}"; do
    if docker exec "$CONTAINER" test -f "$p"; then
      printf '%s\n' "$p"
      return 0
    fi
  done
  echo "PIX webhook runtime file not found" >&2
  return 1
}

outside_hash() {
  local image="$1"
  docker run --rm "$image" sh -lc \
    "find /app/dist -type f ! -path '$TARGET' -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print \\$1}'"
}

rollback() {
  local rc="$?"
  if [ "$DEPLOY_STARTED" = "1" ] && [ -n "$SERVICE_IMAGE_REF" ]; then
    echo
    echo "ROLLBACK: restoring ${BASELINE_IMAGE}"
    docker tag "$BASELINE_IMAGE" "$SERVICE_IMAGE_REF" || true
    cd "$ROOT"
    docker compose up -d --force-recreate --no-build "$COMPOSE_SERVICE" || true
  fi
  docker rm -f "$BUILD_CONTAINER" >/dev/null 2>&1 || true
  exit "$rc"
}
trap rollback ERR

section "1. Production preflight"
curl -fsS https://api.xpayments.digital/api/health
echo

test "$(docker inspect -f '{{.State.Running}}' "$CONTAINER")" = "true"
SERVICE_IMAGE_REF="$(docker inspect -f '{{.Config.Image}}' "$CONTAINER")"
WEBHOOK_PATH="$(resolve_webhook_path)"

echo "SERVICE_IMAGE_REF=${SERVICE_IMAGE_REF}"
echo "WEBHOOK_RUNTIME_PATH=${WEBHOOK_PATH}"

DIRECT_SHA="$(sha_in_container "$DIRECT_PATH")"
PIX_SHA="$(sha_in_container "$PIX_PATH")"
MISTIC_SHA="$(sha_in_container "$TARGET")"
WEBHOOK_SHA="$(sha_in_container "$WEBHOOK_PATH")"
ROUTES_SHA="$(sha_in_container "$ROUTES_PATH")"

echo "DIRECT_RUNTIME_SHA=${DIRECT_SHA}"
echo "PIX_RUNTIME_SHA=${PIX_SHA}"
echo "MISTIC_RUNTIME_SHA=${MISTIC_SHA}"
echo "MISTIC_WEBHOOK_SHA=${WEBHOOK_SHA}"
echo "PAYMENTS_ROUTES_SHA=${ROUTES_SHA}"

test "$DIRECT_SHA" = "$EXPECTED_DIRECT_SHA"
test "$PIX_SHA" = "$EXPECTED_PIX_SHA"
test "$MISTIC_SHA" = "$EXPECTED_MISTIC_SHA"
test "$WEBHOOK_SHA" = "$EXPECTED_WEBHOOK_SHA"
test "$ROUTES_SHA" = "$EXPECTED_ROUTES_SHA"

echo "PAYMENT_RUNTIME_PREFLIGHT=PASS"

section "2. Commit current runtime baseline"
docker commit "$CONTAINER" "$BASELINE_IMAGE" >/dev/null
echo "BASELINE_IMAGE=${BASELINE_IMAGE}"

section "3. Patch only compiled PIX provider gate"
docker create --name "$BUILD_CONTAINER" "$BASELINE_IMAGE" >/dev/null
docker cp "$BUILD_CONTAINER:$TARGET" "$WORKDIR/misticpay.service.js"
cp "$WORKDIR/misticpay.service.js" "$WORKDIR/misticpay.service.original.js"

python3 - "$WORKDIR/misticpay.service.js" <<'PY'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
text = path.read_text()
pattern = re.compile(
    r"if\s*\(\s*!gatewayVault\s*\|\|\s*!gatewayVault\.provider\s*\.toLowerCase\(\)\s*\.startsWith\(['\"]misticpay['\"]\)\s*\)\s*\{",
    re.MULTILINE,
)
patched, count = pattern.subn("if (!gatewayVault) {", text)
if count != 1:
    raise SystemExit(f"PATCH_MATCH_COUNT={count}; expected exactly 1")
path.write_text(patched)
print("PATCH_MATCH_COUNT=1")
PY

node --check "$WORKDIR/misticpay.service.js"
ORIGINAL_SHA="$(sha256sum "$WORKDIR/misticpay.service.original.js" | awk '{print $1}')"
PATCHED_SHA="$(sha256sum "$WORKDIR/misticpay.service.js" | awk '{print $1}')"
echo "ORIGINAL_MISTIC_SHA=${ORIGINAL_SHA}"
echo "PATCHED_MISTIC_SHA=${PATCHED_SHA}"
test "$ORIGINAL_SHA" = "$EXPECTED_MISTIC_SHA"
test "$PATCHED_SHA" != "$ORIGINAL_SHA"

docker cp "$WORKDIR/misticpay.service.js" "$BUILD_CONTAINER:$TARGET"
docker cp "$BUILD_CONTAINER:$TARGET" "$WORKDIR/misticpay.service.candidate.js"
CANDIDATE_TARGET_SHA="$(sha256sum "$WORKDIR/misticpay.service.candidate.js" | awk '{print $1}')"
test "$CANDIDATE_TARGET_SHA" = "$PATCHED_SHA"
echo "TARGET_PATCH=PASS"

section "4. Candidate isolation check"
BASELINE_OUTSIDE_HASH="$(outside_hash "$BASELINE_IMAGE")"
CANDIDATE_TMP_IMAGE="xpayments-pix-provider-transparent-tmp:${STAMP}"
docker commit "$BUILD_CONTAINER" "$CANDIDATE_TMP_IMAGE" >/dev/null
CANDIDATE_OUTSIDE_HASH="$(outside_hash "$CANDIDATE_TMP_IMAGE")"
echo "BASELINE_OUTSIDE_HASH=${BASELINE_OUTSIDE_HASH}"
echo "CANDIDATE_OUTSIDE_HASH=${CANDIDATE_OUTSIDE_HASH}"
test "$BASELINE_OUTSIDE_HASH" = "$CANDIDATE_OUTSIDE_HASH"

docker tag "$CANDIDATE_TMP_IMAGE" "$CANDIDATE_IMAGE"
echo "CANDIDATE_IMAGE=${CANDIDATE_IMAGE}"

section "5. Deploy candidate without build"
DEPLOY_STARTED=1
docker tag "$CANDIDATE_IMAGE" "$SERVICE_IMAGE_REF"
cd "$ROOT"
docker compose up -d --force-recreate --no-build "$COMPOSE_SERVICE"

for i in $(seq 1 30); do
  if curl -fsS https://api.xpayments.digital/api/health >/tmp/xpay-pix-health.json 2>/dev/null; then
    cat /tmp/xpay-pix-health.json
    echo
    break
  fi
  sleep 1
  if [ "$i" = "30" ]; then
    echo "API health did not recover"
    false
  fi
done

section "6. Runtime integrity"
RUNTIME_PATCHED_SHA="$(sha_in_container "$TARGET")"
DIRECT_AFTER="$(sha_in_container "$DIRECT_PATH")"
PIX_AFTER="$(sha_in_container "$PIX_PATH")"
WEBHOOK_AFTER="$(sha_in_container "$WEBHOOK_PATH")"
ROUTES_AFTER="$(sha_in_container "$ROUTES_PATH")"

echo "RUNTIME_PATCHED_MISTIC_SHA=${RUNTIME_PATCHED_SHA}"
echo "EXPECTED_PATCHED_MISTIC_SHA=${PATCHED_SHA}"
test "$RUNTIME_PATCHED_SHA" = "$PATCHED_SHA"
test "$DIRECT_AFTER" = "$EXPECTED_DIRECT_SHA"
test "$PIX_AFTER" = "$EXPECTED_PIX_SHA"
test "$WEBHOOK_AFTER" = "$EXPECTED_WEBHOOK_SHA"
test "$ROUTES_AFTER" = "$EXPECTED_ROUTES_SHA"

echo "PAYMENT_RUNTIME_OUTSIDE_TARGET_UNCHANGED=PASS"

section "7. Final health"
curl -fsS https://api.xpayments.digital/api/health
echo

DEPLOY_STARTED=0
docker rm -f "$BUILD_CONTAINER" >/dev/null 2>&1 || true

echo "PIX_PROVIDER_TRANSPARENCY_HOTPATCH=PASS"
echo "PUBLIC_ALIAS_READY=pix-primary"
echo "BASELINE_IMAGE=${BASELINE_IMAGE}"
echo "CANDIDATE_IMAGE=${CANDIDATE_IMAGE}"
echo "NO_PAYMENT_CREATED=YES"
