#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="/root/xpayments-backend-v3"
CONTAINER="xpayments-api-v3"
HEALTH_URL="https://api.xpayments.digital/api/health"
SOURCE_BRANCH="main"
SOURCE_COMMIT="da06bba19e6b72ed468883f7ec61b936b47732ed"
DIRECT_SOURCE_SHA_EXPECTED="f4ac2ee6f982ed98f59b90ce45ec6b12691ed31bd1e84472510cbec90e696b32"
DIRECT_RUNTIME_SHA_EXPECTED="9a1b097a929519d68caf66c2bb804519af1cdc7e2823208aa3e12daea7571874"
PIX_RUNTIME_SHA_EXPECTED="3f5ef483e822294a431ae444d3408413095e128fb2b69fa580850d36ab5d0001"
MISTIC_RUNTIME_SHA_EXPECTED="9b9a8264a0af7598160643bd2fcb357b0da3d04d826c9f3ec7d05c81187a3cc6"
MISTIC_WEBHOOK_SHA_EXPECTED="b22fd255abe853f269d10068e3802805e72882671a1ade530952582f6ad66901"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="/root/.xpayments-hotpatch/customer-readmodel-v2-${STAMP}"
BASELINE_IMAGE="xpayments-prod-pre-customer-readmodel-v2:${STAMP}"
CANDIDATE_IMAGE="xpayments-customer-readmodel-v2:${STAMP}"
CANDIDATE_CONTAINER="xpayments-customer-readmodel-build-${STAMP}"
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

runtime_sha() {
  docker exec "$CONTAINER" sha256sum "$1" | awk '{print $1}'
}

image_hash_excluding_targets() {
  local image="$1"
  docker run --rm "$image" sh -lc '
    find /app/dist -type f \
      ! -path "/app/dist/modules/commerce/controllers/customer-readmodel.controller.js" \
      ! -path "/app/dist/modules/commerce/routes/commerce.routes.js" \
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
DIRECT_SOURCE_SHA_ACTUAL="$(sha256sum src/modules/payments/controllers/direct.controller.ts | awk '{print $1}')"
echo "DIRECT_SOURCE_SHA_ACTUAL=${DIRECT_SOURCE_SHA_ACTUAL}"
echo "DIRECT_SOURCE_SHA_EXPECTED=${DIRECT_SOURCE_SHA_EXPECTED}"
test "$DIRECT_SOURCE_SHA_ACTUAL" = "$DIRECT_SOURCE_SHA_EXPECTED"

docker inspect "$CONTAINER" >/dev/null
RUNNING="$(docker inspect -f '{{.State.Running}}' "$CONTAINER")"
echo "CONTAINER_RUNNING=${RUNNING}"
test "$RUNNING" = "true"

DIRECT_RUNTIME_SHA_ACTUAL="$(runtime_sha /app/dist/modules/payments/controllers/direct.controller.js)"
PIX_RUNTIME_SHA_ACTUAL="$(runtime_sha /app/dist/modules/payments/controllers/pix.controller.js)"
MISTIC_RUNTIME_SHA_ACTUAL="$(runtime_sha /app/dist/modules/payments/services/misticpay.service.js)"
MISTIC_WEBHOOK_SHA_ACTUAL="$(runtime_sha /app/dist/modules/payments/controllers/misticpay.webhook.js)"

echo "DIRECT_RUNTIME_SHA_ACTUAL=${DIRECT_RUNTIME_SHA_ACTUAL}"
echo "PIX_RUNTIME_SHA_ACTUAL=${PIX_RUNTIME_SHA_ACTUAL}"
echo "MISTIC_RUNTIME_SHA_ACTUAL=${MISTIC_RUNTIME_SHA_ACTUAL}"
echo "MISTIC_WEBHOOK_SHA_ACTUAL=${MISTIC_WEBHOOK_SHA_ACTUAL}"

test "$DIRECT_RUNTIME_SHA_ACTUAL" = "$DIRECT_RUNTIME_SHA_EXPECTED"
test "$PIX_RUNTIME_SHA_ACTUAL" = "$PIX_RUNTIME_SHA_EXPECTED"
test "$MISTIC_RUNTIME_SHA_ACTUAL" = "$MISTIC_RUNTIME_SHA_EXPECTED"
test "$MISTIC_WEBHOOK_SHA_ACTUAL" = "$MISTIC_WEBHOOK_SHA_EXPECTED"

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
  "$WORK/src/modules/commerce/controllers" \
  "$WORK/src/modules/commerce/routes" \
  "$WORK/src/core" \
  "$WORK/src/middleware" \
  "$WORK/out"

git show "${SOURCE_COMMIT}:src/modules/commerce/controllers/customer-readmodel.controller.ts" \
  > "$WORK/src/modules/commerce/controllers/customer-readmodel.controller.ts"
git show "${SOURCE_COMMIT}:src/modules/commerce/routes/commerce.routes.ts" \
  > "$WORK/src/modules/commerce/routes/commerce.routes.ts"

cat > "$WORK/src/core/prisma.d.ts" <<'EOF'
import { Prisma } from '@prisma/client';

interface PrismaHotpatchStub {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
}

declare const prisma: PrismaHotpatchStub;
export default prisma;
EOF

cat > "$WORK/src/middleware/auth.middleware.d.ts" <<'EOF'
export interface AuthRequest {
  user?: any;
  merchantId?: string;
  params: any;
  query: any;
  body: any;
  headers: any;
}
EOF

cat > "$WORK/src/modules/commerce/controllers/commerce.controller.d.ts" <<'EOF'
export const getTransactions: any;
export const getStores: any;
export const getProducts: any;
export const createProduct: any;
export const deleteProduct: any;
export const getPaymentLinks: any;
export const getInvoices: any;
export const getSubscriptions: any;
EOF

say "3. Commit current runtime as rollback baseline"
docker commit "$CONTAINER" "$BASELINE_IMAGE" >/dev/null
echo "BASELINE_IMAGE=${BASELINE_IMAGE}"

say "4. Isolated TypeScript compile"
docker run --rm \
  -v "$WORK:/hotpatch" \
  "$BASELINE_IMAGE" \
  sh -lc '
    ln -sfn /app/node_modules /hotpatch/node_modules
    /app/node_modules/.bin/tsc \
      --target ES2020 \
      --module commonjs \
      --moduleResolution node \
      --esModuleInterop \
      --skipLibCheck \
      --rootDir /hotpatch/src \
      --outDir /hotpatch/out \
      /hotpatch/src/modules/commerce/controllers/customer-readmodel.controller.ts \
      /hotpatch/src/modules/commerce/routes/commerce.routes.ts
  '

CUSTOMER_JS="$WORK/out/modules/commerce/controllers/customer-readmodel.controller.js"
ROUTES_JS="$WORK/out/modules/commerce/routes/commerce.routes.js"
test -s "$CUSTOMER_JS"
test -s "$ROUTES_JS"

docker run --rm -v "$WORK:/hotpatch" "$BASELINE_IMAGE" \
  node --check /hotpatch/out/modules/commerce/controllers/customer-readmodel.controller.js
docker run --rm -v "$WORK:/hotpatch" "$BASELINE_IMAGE" \
  node --check /hotpatch/out/modules/commerce/routes/commerce.routes.js

CUSTOMER_JS_SHA="$(sha256sum "$CUSTOMER_JS" | awk '{print $1}')"
ROUTES_JS_SHA="$(sha256sum "$ROUTES_JS" | awk '{print $1}')"
echo "CUSTOMER_JS_SHA=${CUSTOMER_JS_SHA}"
echo "ROUTES_JS_SHA=${ROUTES_JS_SHA}"

say "5. Build candidate from certified running baseline"
docker create --name "$CANDIDATE_CONTAINER" "$BASELINE_IMAGE" >/dev/null
docker cp "$CUSTOMER_JS" "$CANDIDATE_CONTAINER:/app/dist/modules/commerce/controllers/customer-readmodel.controller.js"
docker cp "$ROUTES_JS" "$CANDIDATE_CONTAINER:/app/dist/modules/commerce/routes/commerce.routes.js"
docker commit "$CANDIDATE_CONTAINER" "$CANDIDATE_IMAGE" >/dev/null
docker rm "$CANDIDATE_CONTAINER" >/dev/null

BASELINE_OUTSIDE_HASH="$(image_hash_excluding_targets "$BASELINE_IMAGE")"
CANDIDATE_OUTSIDE_HASH="$(image_hash_excluding_targets "$CANDIDATE_IMAGE")"
echo "BASELINE_OUTSIDE_HASH=${BASELINE_OUTSIDE_HASH}"
echo "CANDIDATE_OUTSIDE_HASH=${CANDIDATE_OUTSIDE_HASH}"
test "$BASELINE_OUTSIDE_HASH" = "$CANDIDATE_OUTSIDE_HASH"

say "6. Candidate runtime checks"
docker run --rm "$CANDIDATE_IMAGE" node --check /app/dist/modules/commerce/controllers/customer-readmodel.controller.js
docker run --rm "$CANDIDATE_IMAGE" node --check /app/dist/modules/commerce/routes/commerce.routes.js
docker run --rm "$CANDIDATE_IMAGE" sh -lc '
  grep -q "metricsByCurrency" /app/dist/modules/commerce/controllers/customer-readmodel.controller.js &&
  grep -q "getCustomersV2" /app/dist/modules/commerce/routes/commerce.routes.js
'

say "7. Deploy candidate without build"
docker tag "$CANDIDATE_IMAGE" "$SERVICE_IMAGE_REF"
DEPLOY_STARTED=1
docker compose up -d --no-deps --force-recreate "$SERVICE"

for attempt in $(seq 1 40); do
  if health_gate >/tmp/xpayments-customer-readmodel-health.json 2>/dev/null; then
    cat /tmp/xpayments-customer-readmodel-health.json
    break
  fi
  if [[ "$attempt" == "40" ]]; then
    echo "Health did not recover"
    false
  fi
  sleep 2
done

say "8. Runtime integrity"
RUNTIME_CUSTOMER_SHA="$(runtime_sha /app/dist/modules/commerce/controllers/customer-readmodel.controller.js)"
RUNTIME_ROUTES_SHA="$(runtime_sha /app/dist/modules/commerce/routes/commerce.routes.js)"
echo "RUNTIME_CUSTOMER_SHA=${RUNTIME_CUSTOMER_SHA}"
echo "COMPILED_CUSTOMER_SHA=${CUSTOMER_JS_SHA}"
echo "RUNTIME_ROUTES_SHA=${RUNTIME_ROUTES_SHA}"
echo "COMPILED_ROUTES_SHA=${ROUTES_JS_SHA}"
test "$RUNTIME_CUSTOMER_SHA" = "$CUSTOMER_JS_SHA"
test "$RUNTIME_ROUTES_SHA" = "$ROUTES_JS_SHA"

# Payment runtime must remain byte-identical.
test "$(runtime_sha /app/dist/modules/payments/controllers/direct.controller.js)" = "$DIRECT_RUNTIME_SHA_EXPECTED"
test "$(runtime_sha /app/dist/modules/payments/controllers/pix.controller.js)" = "$PIX_RUNTIME_SHA_EXPECTED"
test "$(runtime_sha /app/dist/modules/payments/services/misticpay.service.js)" = "$MISTIC_RUNTIME_SHA_EXPECTED"
test "$(runtime_sha /app/dist/modules/payments/controllers/misticpay.webhook.js)" = "$MISTIC_WEBHOOK_SHA_EXPECTED"

docker exec "$CONTAINER" sh -lc '
  grep -q "metricsByCurrency" /app/dist/modules/commerce/controllers/customer-readmodel.controller.js &&
  grep -q "getCustomersV2" /app/dist/modules/commerce/routes/commerce.routes.js
'

say "9. Non-authenticated safety probe"
HTTP_CODE="$(curl -sS -o "$WORK/unauth.json" -w '%{http_code}' \
  "https://api.xpayments.digital/api/v1/customers")"
echo "UNAUTH_HTTP=${HTTP_CODE}"
cat "$WORK/unauth.json"
test "$HTTP_CODE" = "401"

say "10. Final health"
health_gate
DEPLOY_STARTED=0
trap - ERR

echo
echo "CUSTOMER_READMODEL_V2_HOTPATCH=PASS"
echo "BASELINE_IMAGE=${BASELINE_IMAGE}"
echo "CANDIDATE_IMAGE=${CANDIDATE_IMAGE}"
echo "PAYMENT_RUNTIME_UNCHANGED=PASS"
echo "No payment, provider, transaction, wallet or ledger operation was created by this deployment."
