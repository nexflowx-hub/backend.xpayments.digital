#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="/root/xpayments-backend-v3"
CONTAINER="xpayments-api-v3"
HEALTH_URL="https://api.xpayments.digital/api/health"
SOURCE_BRANCH="feat/developer-secrets-hardening-20260912"
SOURCE_COMMIT="40391e796552c4a7c985d2713ab12e39142a3e04"
DIRECT_SHA_EXPECTED="f4ac2ee6f982ed98f59b90ce45ec6b12691ed31bd1e84472510cbec90e696b32"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="/root/.xpayments-hotpatch/developer-secrets-${STAMP}"
BASELINE_IMAGE="xpayments-prod-pre-developer-secrets:${STAMP}"
CANDIDATE_IMAGE="xpayments-developer-secrets:${STAMP}"
CANDIDATE_CONTAINER="xpayments-developer-secrets-build-${STAMP}"
DEPLOY_STARTED=0

cd "$ROOT"

say() {
  printf '\n======================================================\n%s\n======================================================\n' "$1"
}

health_gate() {
  local payload
  payload="$(curl -fsS "$HEALTH_URL")"
  echo "$payload"
  echo "$payload" | grep -q '"status":"ONLINE"'
  echo "$payload" | grep -q '"engine":"XPayments"'
}

image_hash_excluding_targets() {
  local image="$1"
  docker run --rm "$image" sh -lc '
    find /app/dist -type f \
      ! -path "/app/dist/modules/developer/controllers/developer-secrets.controller.js" \
      ! -path "/app/dist/modules/developer/routes/developer.routes.js" \
      -print | LC_ALL=C sort | xargs sha256sum | sha256sum | awk "{print \$1}"
  '
}

rollback() {
  local rc=$?
  if [[ "$DEPLOY_STARTED" == "1" ]]; then
    echo
    echo "ROLLBACK: restoring baseline image"
    docker tag "$BASELINE_IMAGE" "$SERVICE_IMAGE_REF"
    docker compose up -d --no-deps --force-recreate "$SERVICE" || true
    health_gate || true
  fi
  docker rm -f "$CANDIDATE_CONTAINER" >/dev/null 2>&1 || true
  exit "$rc"
}
trap rollback ERR

say "1. Production preflight"
health_gate

test -f src/modules/payments/controllers/direct.controller.ts
DIRECT_SHA_ACTUAL="$(sha256sum src/modules/payments/controllers/direct.controller.ts | awk '{print $1}')"
echo "DIRECT_SHA_ACTUAL=${DIRECT_SHA_ACTUAL}"
echo "DIRECT_SHA_EXPECTED=${DIRECT_SHA_EXPECTED}"
test "$DIRECT_SHA_ACTUAL" = "$DIRECT_SHA_EXPECTED"

docker inspect "$CONTAINER" >/dev/null
RUNNING="$(docker inspect -f '{{.State.Running}}' "$CONTAINER")"
echo "CONTAINER_RUNNING=${RUNNING}"
test "$RUNNING" = "true"

SERVICE="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.service" }}' "$CONTAINER")"
SERVICE_IMAGE_REF="$(docker inspect -f '{{.Config.Image}}' "$CONTAINER")"
echo "COMPOSE_SERVICE=${SERVICE}"
echo "SERVICE_IMAGE_REF=${SERVICE_IMAGE_REF}"
test -n "$SERVICE"
test -n "$SERVICE_IMAGE_REF"

say "2. Fetch pinned source"
git fetch origin "$SOURCE_BRANCH"
git cat-file -e "${SOURCE_COMMIT}^{commit}"
mkdir -p \
  "$WORK/src/modules/developer/controllers" \
  "$WORK/src/modules/developer/routes" \
  "$WORK/src/core" \
  "$WORK/src/middleware" \
  "$WORK/out"

git show "${SOURCE_COMMIT}:src/modules/developer/controllers/developer-secrets.controller.ts" \
  > "$WORK/src/modules/developer/controllers/developer-secrets.controller.ts"
git show "${SOURCE_COMMIT}:src/modules/developer/routes/developer.routes.ts" \
  > "$WORK/src/modules/developer/routes/developer.routes.ts"

cat > "$WORK/src/core/prisma.d.ts" <<'EOF'
declare const prisma: any;
export default prisma;
EOF

cat > "$WORK/src/middleware/auth.middleware.d.ts" <<'EOF'
export interface AuthRequest {
  user?: any;
  merchantId?: string;
  params: any;
  body: any;
  headers: any;
}
EOF

cat > "$WORK/src/modules/developer/controllers/developer.controller.d.ts" <<'EOF'
export const getApiKeys: any;
export const createApiKey: any;
export const deleteApiKey: any;
export const getWebhooks: any;
export const createWebhook: any;
export const updateWebhook: any;
export const deleteWebhook: any;
EOF

say "3. Commit current runtime as rollback baseline"
docker commit "$CONTAINER" "$BASELINE_IMAGE" >/dev/null
echo "BASELINE_IMAGE=${BASELINE_IMAGE}"

say "4. Isolated TypeScript compile"
docker run --rm \
  -v "$WORK:/hotpatch" \
  "$BASELINE_IMAGE" \
  sh -lc '
    /app/node_modules/.bin/tsc \
      --target ES2020 \
      --module commonjs \
      --moduleResolution node \
      --esModuleInterop \
      --skipLibCheck \
      --rootDir /hotpatch/src \
      --outDir /hotpatch/out \
      /hotpatch/src/modules/developer/controllers/developer-secrets.controller.ts \
      /hotpatch/src/modules/developer/routes/developer.routes.ts
  '

SECRET_JS="$WORK/out/modules/developer/controllers/developer-secrets.controller.js"
ROUTES_JS="$WORK/out/modules/developer/routes/developer.routes.js"
test -s "$SECRET_JS"
test -s "$ROUTES_JS"

docker run --rm -v "$WORK:/hotpatch" "$BASELINE_IMAGE" \
  node --check /hotpatch/out/modules/developer/controllers/developer-secrets.controller.js
docker run --rm -v "$WORK:/hotpatch" "$BASELINE_IMAGE" \
  node --check /hotpatch/out/modules/developer/routes/developer.routes.js

echo "SECRET_JS_SHA=$(sha256sum "$SECRET_JS" | awk '{print $1}')"
echo "ROUTES_JS_SHA=$(sha256sum "$ROUTES_JS" | awk '{print $1}')"

say "5. Build candidate from certified running baseline"
docker create --name "$CANDIDATE_CONTAINER" "$BASELINE_IMAGE" >/dev/null
docker cp "$SECRET_JS" "$CANDIDATE_CONTAINER:/app/dist/modules/developer/controllers/developer-secrets.controller.js"
docker cp "$ROUTES_JS" "$CANDIDATE_CONTAINER:/app/dist/modules/developer/routes/developer.routes.js"
docker commit "$CANDIDATE_CONTAINER" "$CANDIDATE_IMAGE" >/dev/null
docker rm "$CANDIDATE_CONTAINER" >/dev/null

BASELINE_OUTSIDE_HASH="$(image_hash_excluding_targets "$BASELINE_IMAGE")"
CANDIDATE_OUTSIDE_HASH="$(image_hash_excluding_targets "$CANDIDATE_IMAGE")"
echo "BASELINE_OUTSIDE_HASH=${BASELINE_OUTSIDE_HASH}"
echo "CANDIDATE_OUTSIDE_HASH=${CANDIDATE_OUTSIDE_HASH}"
test "$BASELINE_OUTSIDE_HASH" = "$CANDIDATE_OUTSIDE_HASH"

say "6. Candidate runtime checks"
docker run --rm "$CANDIDATE_IMAGE" node --check /app/dist/modules/developer/controllers/developer-secrets.controller.js
docker run --rm "$CANDIDATE_IMAGE" node --check /app/dist/modules/developer/routes/developer.routes.js
docker run --rm "$CANDIDATE_IMAGE" sh -lc 'grep -q "api-keys/:id/reveal" /app/dist/modules/developer/routes/developer.routes.js && grep -q "rotate-secret" /app/dist/modules/developer/routes/developer.routes.js'

say "7. Deploy candidate without build"
docker tag "$CANDIDATE_IMAGE" "$SERVICE_IMAGE_REF"
DEPLOY_STARTED=1
docker compose up -d --no-deps --force-recreate "$SERVICE"

for attempt in $(seq 1 40); do
  if health_gate >/tmp/xpayments-developer-secrets-health.json 2>/dev/null; then
    cat /tmp/xpayments-developer-secrets-health.json
    break
  fi
  if [[ "$attempt" == "40" ]]; then
    echo "Health did not recover"
    false
  fi
  sleep 2
done

say "8. Runtime integrity"
docker exec "$CONTAINER" node --check /app/dist/modules/developer/controllers/developer-secrets.controller.js
docker exec "$CONTAINER" node --check /app/dist/modules/developer/routes/developer.routes.js
docker exec "$CONTAINER" sh -lc 'grep -q "api-keys/:id/reveal" /app/dist/modules/developer/routes/developer.routes.js && grep -q "api-keys/:id/rotate" /app/dist/modules/developer/routes/developer.routes.js && grep -q "webhooks/:id/reveal" /app/dist/modules/developer/routes/developer.routes.js && grep -q "rotate-secret" /app/dist/modules/developer/routes/developer.routes.js'

RUNTIME_SECRET_SHA="$(docker exec "$CONTAINER" sha256sum /app/dist/modules/developer/controllers/developer-secrets.controller.js | awk '{print $1}')"
RUNTIME_ROUTES_SHA="$(docker exec "$CONTAINER" sha256sum /app/dist/modules/developer/routes/developer.routes.js | awk '{print $1}')"
COMPILED_SECRET_SHA="$(sha256sum "$SECRET_JS" | awk '{print $1}')"
COMPILED_ROUTES_SHA="$(sha256sum "$ROUTES_JS" | awk '{print $1}')"

echo "RUNTIME_SECRET_SHA=${RUNTIME_SECRET_SHA}"
echo "COMPILED_SECRET_SHA=${COMPILED_SECRET_SHA}"
echo "RUNTIME_ROUTES_SHA=${RUNTIME_ROUTES_SHA}"
echo "COMPILED_ROUTES_SHA=${COMPILED_ROUTES_SHA}"
test "$RUNTIME_SECRET_SHA" = "$COMPILED_SECRET_SHA"
test "$RUNTIME_ROUTES_SHA" = "$COMPILED_ROUTES_SHA"

say "9. Non-authenticated safety probe"
HTTP_CODE="$(curl -sS -o "$WORK/unauth.json" -w '%{http_code}' -X POST "https://api.xpayments.digital/api/v1/api-keys/00000000-0000-0000-0000-000000000000/reveal" -H 'Content-Type: application/json' --data '{}')"
echo "UNAUTH_HTTP=${HTTP_CODE}"
cat "$WORK/unauth.json"
test "$HTTP_CODE" = "401"

say "10. Final health"
health_gate
DEPLOY_STARTED=0
trap - ERR

echo
echo "DEVELOPER_SECRETS_HOTPATCH=PASS"
echo "BASELINE_IMAGE=${BASELINE_IMAGE}"
echo "CANDIDATE_IMAGE=${CANDIDATE_IMAGE}"
echo "No payment, transaction, wallet movement or provider operation was created by this deployment."
