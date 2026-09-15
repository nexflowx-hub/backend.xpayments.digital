#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="/root/xpayments-backend-v3"
CONTAINER="xpayments-api-v3"
COMPOSE_SERVICE="xpayments-api-v3"
FEATURE_BRANCH="feat/pix-d1-mypets-20260915"
BASE_BRANCH="feat/pix-misticpay-br001-20260821"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORKROOT="/root/.xpayments-pix-d1/${STAMP}"
BASE_SRC="${WORKROOT}/base-src"
FEATURE_SRC="${WORKROOT}/feature-src"
EXTRACT="${WORKROOT}/extract"

BASE_BUILD_IMAGE="xpayments-pix-d1-base-build:${STAMP}"
FEATURE_BUILD_IMAGE="xpayments-pix-d1-feature-build:${STAMP}"
BASELINE_IMAGE="xpayments-prod-pre-pix-d1:${STAMP}"
CANDIDATE_IMAGE="xpayments-pix-d1-candidate:${STAMP}"

BASE_BUILD_CONTAINER="xpayments-pix-d1-base-${STAMP}"
FEATURE_BUILD_CONTAINER="xpayments-pix-d1-feature-${STAMP}"
CANDIDATE_CONTAINER="xpayments-pix-d1-candidate-${STAMP}"

SERVICE_IMAGE_REF=""
DEPLOY_STARTED=0

COMPARE_FILES=(
  "/app/dist/core/app.js"
  "/app/dist/modules/payments/controllers/pix.controller.js"
  "/app/dist/modules/payments/routes/payments.routes.js"
)

TARGET_FILES=(
  "/app/dist/core/app.js"
  "/app/dist/modules/payments/controllers/pix.controller.js"
  "/app/dist/modules/payments/controllers/pixgo.webhook.js"
  "/app/dist/modules/payments/routes/payments.routes.js"
  "/app/dist/modules/payments/services/pix-router.service.js"
  "/app/dist/modules/payments/services/pixgo.service.js"
)

MISTIC_TARGET="/app/dist/modules/payments/services/misticpay.service.js"

section() {
  echo
  echo "======================================================"
  echo "$1"
  echo "======================================================"
}

runtime_sha() {
  docker exec "$CONTAINER" sha256sum "$1" | awk '{print $1}'
}

image_sha() {
  docker run --rm --entrypoint sha256sum "$1" "$2" | awk '{print $1}'
}

outside_hash() {
  local image="$1"
  docker run --rm "$image" sh -lc \
    "find /app/dist -type f \
      ! -path '/app/dist/core/app.js' \
      ! -path '/app/dist/modules/payments/controllers/pix.controller.js' \
      ! -path '/app/dist/modules/payments/controllers/pixgo.webhook.js' \
      ! -path '/app/dist/modules/payments/routes/payments.routes.js' \
      ! -path '/app/dist/modules/payments/services/pix-router.service.js' \
      ! -path '/app/dist/modules/payments/services/pixgo.service.js' \
      -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print \\$1}'"
}

cleanup() {
  docker rm -f \
    "$BASE_BUILD_CONTAINER" \
    "$FEATURE_BUILD_CONTAINER" \
    "$CANDIDATE_CONTAINER" \
    >/dev/null 2>&1 || true

  if [ -d "$BASE_SRC" ]; then
    git -C "$ROOT" worktree remove --force "$BASE_SRC" >/dev/null 2>&1 || true
  fi
  if [ -d "$FEATURE_SRC" ]; then
    git -C "$ROOT" worktree remove --force "$FEATURE_SRC" >/dev/null 2>&1 || true
  fi
}

rollback() {
  local rc="$?"
  echo
  echo "DEPLOY_ERROR_RC=${rc}"

  if [ "$DEPLOY_STARTED" = "1" ] && [ -n "$SERVICE_IMAGE_REF" ]; then
    echo "ROLLBACK: restoring ${BASELINE_IMAGE}"
    docker tag "$BASELINE_IMAGE" "$SERVICE_IMAGE_REF" || true
    cd "$ROOT"
    docker compose up -d --force-recreate --no-build "$COMPOSE_SERVICE" || true
  fi

  cleanup
  exit "$rc"
}
trap rollback ERR

mkdir -p "$WORKROOT" "$EXTRACT"

section "1. Production preflight"
curl -fsS https://api.xpayments.digital/api/health
echo

test -d "$ROOT/.git"
test "$(docker inspect -f '{{.State.Running}}' "$CONTAINER")" = "true"
SERVICE_IMAGE_REF="$(docker inspect -f '{{.Config.Image}}' "$CONTAINER")"
echo "SERVICE_IMAGE_REF=${SERVICE_IMAGE_REF}"

MISTIC_SHA_BEFORE="$(runtime_sha "$MISTIC_TARGET")"
echo "LEGACY_PIX_RUNTIME_SHA=${MISTIC_SHA_BEFORE}"

section "2. Fetch immutable source refs"
git -C "$ROOT" fetch origin "$BASE_BRANCH" "$FEATURE_BRANCH"

git -C "$ROOT" worktree add --detach "$BASE_SRC" "origin/$BASE_BRANCH"
git -C "$ROOT" worktree add --detach "$FEATURE_SRC" "origin/$FEATURE_BRANCH"

echo "BASE_HEAD=$(git -C "$BASE_SRC" rev-parse HEAD)"
echo "FEATURE_HEAD=$(git -C "$FEATURE_SRC" rev-parse HEAD)"

section "3. Build base and feature images"
docker build -t "$BASE_BUILD_IMAGE" "$BASE_SRC"
docker build -t "$FEATURE_BUILD_IMAGE" "$FEATURE_SRC"

section "4. Runtime drift guard"
for file in "${COMPARE_FILES[@]}"; do
  runtime="$(runtime_sha "$file")"
  base="$(image_sha "$BASE_BUILD_IMAGE" "$file")"
  echo "FILE=${file}"
  echo "  RUNTIME=${runtime}"
  echo "  BASE=${base}"
  test "$runtime" = "$base"
done

echo "RUNTIME_BASELINE_MATCH=PASS"

section "5. Commit production baseline"
docker commit "$CONTAINER" "$BASELINE_IMAGE" >/dev/null
echo "BASELINE_IMAGE=${BASELINE_IMAGE}"

section "6. Assemble selective candidate"
docker create --name "$FEATURE_BUILD_CONTAINER" "$FEATURE_BUILD_IMAGE" >/dev/null
docker create --name "$CANDIDATE_CONTAINER" "$BASELINE_IMAGE" >/dev/null

for target in "${TARGET_FILES[@]}"; do
  rel="${target#/app/}"
  mkdir -p "$EXTRACT/$(dirname "$rel")"
  docker cp "$FEATURE_BUILD_CONTAINER:$target" "$EXTRACT/$rel"
  docker cp "$EXTRACT/$rel" "$CANDIDATE_CONTAINER:$target"
done

docker commit "$CANDIDATE_CONTAINER" "$CANDIDATE_IMAGE" >/dev/null

BASE_OUTSIDE_HASH="$(outside_hash "$BASELINE_IMAGE")"
CANDIDATE_OUTSIDE_HASH="$(outside_hash "$CANDIDATE_IMAGE")"
echo "BASE_OUTSIDE_HASH=${BASE_OUTSIDE_HASH}"
echo "CANDIDATE_OUTSIDE_HASH=${CANDIDATE_OUTSIDE_HASH}"
test "$BASE_OUTSIDE_HASH" = "$CANDIDATE_OUTSIDE_HASH"
echo "SELECTIVE_IMAGE_INTEGRITY=PASS"

for target in "${TARGET_FILES[@]}"; do
  docker run --rm --entrypoint node "$CANDIDATE_IMAGE" --check "$target" >/dev/null
done
echo "NODE_SYNTAX_CHECK=PASS"

section "7. Deploy candidate"
DEPLOY_STARTED=1
docker tag "$CANDIDATE_IMAGE" "$SERVICE_IMAGE_REF"
cd "$ROOT"
docker compose up -d --force-recreate --no-build "$COMPOSE_SERVICE"

for i in $(seq 1 40); do
  if curl -fsS https://api.xpayments.digital/api/health >/tmp/xpayments-pix-d1-health.json 2>/dev/null; then
    cat /tmp/xpayments-pix-d1-health.json
    echo
    break
  fi
  sleep 1
  if [ "$i" = "40" ]; then
    echo "API health did not recover"
    false
  fi
done

section "8. Runtime integrity"
for target in "${TARGET_FILES[@]}"; do
  runtime="$(runtime_sha "$target")"
  feature="$(image_sha "$FEATURE_BUILD_IMAGE" "$target")"
  echo "FILE=${target}"
  echo "  RUNTIME=${runtime}"
  echo "  FEATURE=${feature}"
  test "$runtime" = "$feature"
done

MISTIC_SHA_AFTER="$(runtime_sha "$MISTIC_TARGET")"
echo "LEGACY_PIX_SHA_BEFORE=${MISTIC_SHA_BEFORE}"
echo "LEGACY_PIX_SHA_AFTER=${MISTIC_SHA_AFTER}"
test "$MISTIC_SHA_BEFORE" = "$MISTIC_SHA_AFTER"

echo "LEGACY_PIX_UNCHANGED=PASS"

section "9. Webhook route smoke test"
WEBHOOK_HTTP="$(curl -sS -o /tmp/xpayments-pix-d1-webhook.json -w '%{http_code}' \
  -X POST \
  -H 'Content-Type: application/json' \
  -d '{}' \
  https://api.xpayments.digital/api/v1/payments/webhooks/pix-d1)"
cat /tmp/xpayments-pix-d1-webhook.json
echo
echo "WEBHOOK_HTTP=${WEBHOOK_HTTP}"
test "$WEBHOOK_HTTP" = "400"

section "10. Final health"
curl -fsS https://api.xpayments.digital/api/health
echo

DEPLOY_STARTED=0
cleanup

echo "PIX_D1_CODE_DEPLOY=PASS"
echo "ROUTING_CHANGED=NO"
echo "MYPETS_REMAINS_ON_EXISTING_PIX_PROVIDER=YES"
echo "BASELINE_IMAGE=${BASELINE_IMAGE}"
echo "CANDIDATE_IMAGE=${CANDIDATE_IMAGE}"
echo "Next: configure the new vault, then activate MYPETS-BRL routing explicitly."
