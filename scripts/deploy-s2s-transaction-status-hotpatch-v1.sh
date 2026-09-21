#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="/root/xpayments-backend-v3"
COMPOSE_SERVICE="xpayments-api-v3"
CANONICAL_NAME="xpayments-api-v3"
DIRECT_PATH="/app/dist/modules/payments/controllers/direct.controller.js"
ROUTES_PATH="/app/dist/modules/payments/routes/payments.routes.js"

EXPECTED_DIRECT_SHA="9a1b097a929519d68caf66c2bb804519af1cdc7e2823208aa3e12daea7571874"
EXPECTED_ROUTES_SHA="44baadad7f0ce997487dc75a43876979eef34e5dc8c20ed0d0b802bfed145dcb"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BASELINE_IMAGE="xpayments-prod-pre-s2s-status:${STAMP}"
CANDIDATE_IMAGE="xpayments-s2s-status:${STAMP}"
BUILD_CONTAINER="xpayments-s2s-status-build-${STAMP}"
WORKDIR="/root/.xpayments-s2s-status/${STAMP}"
mkdir -p "$WORKDIR"

DEPLOY_STARTED=0
SERVICE_IMAGE_REF=""

section() {
  echo
  echo "======================================================"
  echo "$1"
  echo "======================================================"
}

find_primary_api() {
  local matches=()
  mapfile -t matches < <(
    docker ps --format '{{.ID}} {{.Ports}}' |
      awk '$0 ~ /127\.0\.0\.1:3001->8084\/tcp/ {print $1}'
  )
  [ "${#matches[@]}" -eq 1 ] || {
    echo "PRIMARY_API_MATCHES=${#matches[@]}" >&2
    docker ps --format 'id={{.ID}} name={{.Names}} status={{.Status}} image={{.Image}} ports={{.Ports}}' >&2
    return 1
  }
  printf '%s\n' "${matches[0]}"
}

api_name() {
  docker inspect -f '{{.Name}}' "$1" | sed 's#^/##'
}

sha_in() {
  docker exec "$1" sha256sum "$2" | cut -d' ' -f1
}

outside_hash() {
  local image="$1"
  docker run --rm "$image" sh -lc \
    "find /app/dist -type f ! -path '$DIRECT_PATH' ! -path '$ROUTES_PATH' -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1"
}

remove_api_containers() {
  local ids=()
  mapfile -t ids < <(
    docker ps -aq --format '{{.ID}} {{.Names}}' |
      awk '$2 == "xpayments-api-v3" || $2 ~ /_xpayments-api-v3$/ {print $1}'
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
    docker inspect "$CANONICAL_NAME" >/dev/null 2>&1 && {
      echo "Canonical API name already occupied" >&2
      return 1
    }
    docker rename "$current" "$CANONICAL_NAME"
  fi
}

wait_health() {
  for _ in $(seq 1 40); do
    if curl -fsS --max-time 5 http://127.0.0.1:3001/api/health >/tmp/xpay-s2s-status-health.json 2>/dev/null; then
      cat /tmp/xpay-s2s-status-health.json
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
  if [ "$DEPLOY_STARTED" = "1" ] && [ -n "$SERVICE_IMAGE_REF" ]; then
    echo
    echo "ROLLBACK: restoring $BASELINE_IMAGE"
    docker tag "$BASELINE_IMAGE" "$SERVICE_IMAGE_REF"
    remove_api_containers
    local rollback_cid
    rollback_cid="$(start_compose_api)"
    if [ -n "$rollback_cid" ]; then
      normalize_name "$rollback_cid"
      wait_health
    fi
  fi
  docker rm -f "$BUILD_CONTAINER" >/dev/null 2>&1
  exit "$rc"
}
trap rollback ERR

section "1. Production preflight"
PRIMARY_CID="$(find_primary_api)"
SERVICE_IMAGE_REF="$(docker inspect -f '{{.Config.Image}}' "$PRIMARY_CID")"
echo "PRIMARY_API_CID=$PRIMARY_CID"
echo "PRIMARY_API_NAME=$(api_name "$PRIMARY_CID")"
echo "SERVICE_IMAGE_REF=$SERVICE_IMAGE_REF"

curl -fsS --max-time 8 https://api.xpayments.digital/api/health
echo

DIRECT_SHA="$(sha_in "$PRIMARY_CID" "$DIRECT_PATH")"
ROUTES_SHA="$(sha_in "$PRIMARY_CID" "$ROUTES_PATH")"
echo "DIRECT_RUNTIME_SHA=$DIRECT_SHA"
echo "PAYMENTS_ROUTES_SHA=$ROUTES_SHA"
test "$DIRECT_SHA" = "$EXPECTED_DIRECT_SHA"
test "$ROUTES_SHA" = "$EXPECTED_ROUTES_SHA"
echo "S2S_STATUS_RUNTIME_PREFLIGHT=PASS"

section "2. Commit current runtime baseline"
docker commit "$PRIMARY_CID" "$BASELINE_IMAGE" >/dev/null
BASELINE_OUTSIDE_HASH="$(outside_hash "$BASELINE_IMAGE")"
echo "BASELINE_IMAGE=$BASELINE_IMAGE"
echo "BASELINE_OUTSIDE_HASH=$BASELINE_OUTSIDE_HASH"

section "3. Patch only S2S status controller and route"
docker create --name "$BUILD_CONTAINER" "$BASELINE_IMAGE" >/dev/null
docker cp "$BUILD_CONTAINER:$DIRECT_PATH" "$WORKDIR/direct.controller.js"
docker cp "$BUILD_CONTAINER:$ROUTES_PATH" "$WORKDIR/payments.routes.js"

python3 - "$WORKDIR/direct.controller.js" "$WORKDIR/payments.routes.js" <<'PY'
from pathlib import Path
import re
import sys

direct_path = Path(sys.argv[1])
routes_path = Path(sys.argv[2])
direct = direct_path.read_text()
routes = routes_path.read_text()

if "getDirectTransactionStatus" in direct or "/transactions/:id" in routes:
    raise SystemExit("S2S status patch already appears to be present")
if not re.search(r"\bconst\s+prisma\s*=", direct):
    raise SystemExit("Could not prove runtime direct controller has local prisma binding")
if "directController" not in routes or "processDirectCharge" not in routes:
    raise SystemExit("Could not prove expected payments route structure")

direct += r'''
exports.getDirectTransactionStatus = async (req, res) => {
    try {
        const authorization = req.headers.authorization;
        const apiKey = authorization?.startsWith('Bearer ')
            ? authorization.slice('Bearer '.length).trim()
            : String(req.headers['x-api-key'] ?? '').trim();
        if (!apiKey) {
            return res.status(401).json({
                success: false,
                error: { code: 'API_KEY_REQUIRED', message: 'API Key não fornecida.' }
            });
        }
        const keyRecord = await prisma.apiKey.findUnique({
            where: { key: apiKey },
            include: { store: true }
        });
        if (!keyRecord || keyRecord.store.status !== 'active') {
            return res.status(401).json({
                success: false,
                error: { code: 'ACCESS_DENIED', message: 'Acesso negado.' }
            });
        }
        const transactionId = Array.isArray(req.params.id)
            ? req.params.id[0]
            : String(req.params.id ?? '').trim();
        if (!transactionId) {
            return res.status(400).json({
                success: false,
                error: { code: 'INVALID_TRANSACTION_ID', message: 'Transação inválida.' }
            });
        }
        const transaction = await prisma.transaction.findFirst({
            where: {
                id: transactionId,
                storeId: keyRecord.store.id,
                merchantId: keyRecord.store.merchantId
            },
            select: {
                id: true,
                reference: true,
                amount: true,
                currency: true,
                status: true,
                method: true,
                createdAt: true
            }
        });
        if (!transaction) {
            return res.status(404).json({
                success: false,
                error: { code: 'TRANSACTION_NOT_FOUND', message: 'Transação não encontrada.' }
            });
        }
        return res.status(200).json({
            success: true,
            data: {
                transactionId: transaction.id,
                reference: transaction.reference,
                amount: Number(transaction.amount),
                currency: transaction.currency,
                status: transaction.status,
                method: transaction.method,
                storeCode: keyRecord.store.storeCode,
                createdAt: transaction.createdAt.toISOString()
            }
        });
    }
    catch (error) {
        console.error('[DIRECT_TRANSACTION_STATUS_ERROR]', error);
        return res.status(500).json({
            success: false,
            error: {
                code: 'TRANSACTION_STATUS_ERROR',
                message: 'Não foi possível consultar a transação.'
            }
        });
    }
};
'''

pattern = re.compile(
    r"(router\.post\(['\"]\/charge['\"]\s*,\s*directController\.processDirectCharge\s*\);)"
)
routes, count = pattern.subn(
    r"\1\nrouter.get('/transactions/:id', directController.getDirectTransactionStatus);",
    routes,
    count=1,
)
if count != 1:
    raise SystemExit(f"ROUTE_PATCH_MATCH_COUNT={count}; expected 1")

direct_path.write_text(direct)
routes_path.write_text(routes)
print("DIRECT_PATCH=PASS")
print("ROUTE_PATCH=PASS")
PY

node --check "$WORKDIR/direct.controller.js"
node --check "$WORKDIR/payments.routes.js"

docker cp "$WORKDIR/direct.controller.js" "$BUILD_CONTAINER:$DIRECT_PATH"
docker cp "$WORKDIR/payments.routes.js" "$BUILD_CONTAINER:$ROUTES_PATH"

CANDIDATE_TMP_IMAGE="xpayments-s2s-status-tmp:${STAMP}"
docker commit "$BUILD_CONTAINER" "$CANDIDATE_TMP_IMAGE" >/dev/null
CANDIDATE_OUTSIDE_HASH="$(outside_hash "$CANDIDATE_TMP_IMAGE")"
echo "CANDIDATE_OUTSIDE_HASH=$CANDIDATE_OUTSIDE_HASH"
test "$BASELINE_OUTSIDE_HASH" = "$CANDIDATE_OUTSIDE_HASH"

docker tag "$CANDIDATE_TMP_IMAGE" "$CANDIDATE_IMAGE"
PATCHED_DIRECT_SHA="$(docker run --rm "$CANDIDATE_IMAGE" sha256sum "$DIRECT_PATH" | cut -d' ' -f1)"
PATCHED_ROUTES_SHA="$(docker run --rm "$CANDIDATE_IMAGE" sha256sum "$ROUTES_PATH" | cut -d' ' -f1)"
test "$PATCHED_DIRECT_SHA" != "$DIRECT_SHA"
test "$PATCHED_ROUTES_SHA" != "$ROUTES_SHA"
echo "PATCHED_DIRECT_SHA=$PATCHED_DIRECT_SHA"
echo "PATCHED_ROUTES_SHA=$PATCHED_ROUTES_SHA"

section "4. Deploy isolated candidate"
DEPLOY_STARTED=1
docker tag "$CANDIDATE_IMAGE" "$SERVICE_IMAGE_REF"
remove_api_containers
NEW_CID="$(start_compose_api)"
normalize_name "$NEW_CID"
NEW_CID="$(find_primary_api)"
wait_health

section "5. Runtime integrity"
test "$(sha_in "$NEW_CID" "$DIRECT_PATH")" = "$PATCHED_DIRECT_SHA"
test "$(sha_in "$NEW_CID" "$ROUTES_PATH")" = "$PATCHED_ROUTES_SHA"
RUNTIME_CHECK_IMAGE="xpayments-s2s-status-runtime-check:${STAMP}"
docker commit "$NEW_CID" "$RUNTIME_CHECK_IMAGE" >/dev/null
RUNTIME_OUTSIDE_HASH="$(outside_hash "$RUNTIME_CHECK_IMAGE")"
echo "RUNTIME_OUTSIDE_HASH=$RUNTIME_OUTSIDE_HASH"
test "$RUNTIME_OUTSIDE_HASH" = "$BASELINE_OUTSIDE_HASH"

section "6. Safe route smoke test"
HTTP_CODE="$(curl -sS -o /tmp/xpay-s2s-status-unauth.json -w '%{http_code}' \
  https://api.xpayments.digital/api/v1/payments/transactions/00000000-0000-0000-0000-000000000000)"
cat /tmp/xpay-s2s-status-unauth.json
echo
test "$HTTP_CODE" = "401"
echo "UNAUTHENTICATED_STATUS_ROUTE=PASS"

section "7. Final public health"
curl -fsS --max-time 8 https://api.xpayments.digital/api/health
echo

DEPLOY_STARTED=0
docker rm -f "$BUILD_CONTAINER" >/dev/null 2>&1 || true

echo "S2S_TRANSACTION_STATUS_HOTPATCH=PASS"
echo "NO_PAYMENT_CREATED=YES"
echo "BASELINE_IMAGE=$BASELINE_IMAGE"
echo "CANDIDATE_IMAGE=$CANDIDATE_IMAGE"
