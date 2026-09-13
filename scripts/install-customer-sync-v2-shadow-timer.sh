#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="/root/xpayments-backend-v3"
HEALTH_URL="https://api.xpayments.digital/api/health"
CONTAINER="xpayments-api-v3"
SOURCE_COMMIT="${SOURCE_COMMIT:-}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="/root/.xpayments-shadow-v2/${STAMP}"
BACKUP="${WORK}/backup"
WORKER_TARGET="/root/xpayments-customer-sync-v2-shadow.mjs"
RUNNER_TARGET="/root/run-customer-sync-v2-shadow.sh"
SERVICE_NAME="xpayments-customer-sync-v2-shadow.service"
TIMER_NAME="xpayments-customer-sync-v2-shadow.timer"
SERVICE_TARGET="/etc/systemd/system/${SERVICE_NAME}"
TIMER_TARGET="/etc/systemd/system/${TIMER_NAME}"
DEPLOY_STARTED=0

if [[ -z "$SOURCE_COMMIT" ]]; then
  echo "SOURCE_COMMIT is required"
  exit 64
fi

mkdir -p "$WORK" "$BACKUP"
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

payment_runtime_hash() {
  docker exec "$CONTAINER" sh -lc '
    sha256sum \
      /app/dist/modules/payments/controllers/direct.controller.js \
      /app/dist/modules/payments/controllers/pix.controller.js \
      /app/dist/modules/payments/services/misticpay.service.js \
      /app/dist/modules/payments/controllers/misticpay.webhook.js \
    | sha256sum | awk "{print \$1}"
  '
}

backup_if_exists() {
  local source="$1"
  local name="$2"
  if [[ -e "$source" ]]; then
    cp -a "$source" "$BACKUP/$name"
    echo "BACKUP_${name}=YES"
  else
    echo "BACKUP_${name}=NO"
  fi
}

restore_or_remove() {
  local target="$1"
  local name="$2"
  if [[ -e "$BACKUP/$name" ]]; then
    cp -a "$BACKUP/$name" "$target"
  else
    rm -f "$target"
  fi
}

PREV_TIMER_ENABLED="$(systemctl is-enabled "$TIMER_NAME" 2>/dev/null || true)"
PREV_TIMER_ACTIVE="$(systemctl is-active "$TIMER_NAME" 2>/dev/null || true)"

rollback() {
  local rc=$?
  if [[ "$DEPLOY_STARTED" == "1" ]]; then
    echo
    echo "ROLLBACK: restoring previous shadow files/units"
    systemctl stop "$TIMER_NAME" >/dev/null 2>&1 || true
    systemctl disable "$TIMER_NAME" >/dev/null 2>&1 || true

    restore_or_remove "$WORKER_TARGET" worker
    restore_or_remove "$RUNNER_TARGET" runner
    restore_or_remove "$SERVICE_TARGET" service
    restore_or_remove "$TIMER_TARGET" timer

    systemctl daemon-reload || true

    if [[ "$PREV_TIMER_ENABLED" == "enabled" ]]; then
      systemctl enable "$TIMER_NAME" >/dev/null 2>&1 || true
    fi
    if [[ "$PREV_TIMER_ACTIVE" == "active" ]]; then
      systemctl start "$TIMER_NAME" >/dev/null 2>&1 || true
    fi

    health_gate || true
  fi
  exit "$rc"
}
trap rollback ERR

say "1. Production safety preflight"
health_gate

docker inspect "$CONTAINER" >/dev/null
test "$(docker inspect -f '{{.State.Running}}' "$CONTAINER")" = "true"

echo "CUSTOMER_V1_TIMER_ACTIVE=$(systemctl is-active xpayments-customer-sync.timer || true)"
echo "CUSTOMER_V1_TIMER_ENABLED=$(systemctl is-enabled xpayments-customer-sync.timer || true)"
test "$(systemctl is-active xpayments-customer-sync.timer)" = "active"

XPAY_EXPERT_STATE="$(systemctl is-active xpay-xpayments-transaction-sync.timer 2>/dev/null || true)"
echo "XPAY_EXPERT_TX_TIMER_ACTIVE=${XPAY_EXPERT_STATE}"
test "$XPAY_EXPERT_STATE" != "active"

PAYMENT_HASH_BEFORE="$(payment_runtime_hash)"
echo "PAYMENT_RUNTIME_HASH_BEFORE=${PAYMENT_HASH_BEFORE}"

say "2. Extract pinned versioned artifacts"
git fetch origin main
git cat-file -e "${SOURCE_COMMIT}^{commit}"

git show "${SOURCE_COMMIT}:scripts/customer-sync-v2-shadow.mjs" > "$WORK/worker.mjs"
git show "${SOURCE_COMMIT}:scripts/run-customer-sync-v2-shadow.sh" > "$WORK/runner.sh"
git show "${SOURCE_COMMIT}:scripts/systemd/${SERVICE_NAME}" > "$WORK/service"
git show "${SOURCE_COMMIT}:scripts/systemd/${TIMER_NAME}" > "$WORK/timer"

node --check "$WORK/worker.mjs"
bash -n "$WORK/runner.sh"
grep -q "SET TRANSACTION READ ONLY" "$WORK/worker.mjs"
grep -q "CUSTOMER_SYNC_V2_SHADOW_RUNNER=PASS" "$WORK/runner.sh"
grep -q "ExecStart=/root/run-customer-sync-v2-shadow.sh" "$WORK/service"
grep -q "OnUnitActiveSec=5min" "$WORK/timer"

echo "WORKER_SHA=$(sha256sum "$WORK/worker.mjs" | awk '{print $1}')"
echo "RUNNER_SHA=$(sha256sum "$WORK/runner.sh" | awk '{print $1}')"
echo "SERVICE_SHA=$(sha256sum "$WORK/service" | awk '{print $1}')"
echo "TIMER_SHA=$(sha256sum "$WORK/timer" | awk '{print $1}')"
echo "ARTIFACT_CHECK=PASS"

say "3. Backup previous shadow installation"
backup_if_exists "$WORKER_TARGET" worker
backup_if_exists "$RUNNER_TARGET" runner
backup_if_exists "$SERVICE_TARGET" service
backup_if_exists "$TIMER_TARGET" timer

say "4. Install shadow artifacts only"
DEPLOY_STARTED=1
install -m 0700 "$WORK/worker.mjs" "$WORKER_TARGET"
install -m 0700 "$WORK/runner.sh" "$RUNNER_TARGET"
install -m 0644 "$WORK/service" "$SERVICE_TARGET"
install -m 0644 "$WORK/timer" "$TIMER_TARGET"
systemctl daemon-reload

say "5. One-shot systemd shadow validation"
systemctl reset-failed "$SERVICE_NAME" >/dev/null 2>&1 || true
systemctl start "$SERVICE_NAME"
SERVICE_RESULT="$(systemctl show "$SERVICE_NAME" -p Result --value)"
echo "SHADOW_SERVICE_RESULT=${SERVICE_RESULT}"
test "$SERVICE_RESULT" = "success"

journalctl -u "$SERVICE_NAME" -n 100 --no-pager -o cat > "$WORK/shadow-journal.txt"
grep -q "CUSTOMER_SYNC_V2_SHADOW_RUNNER=PASS" "$WORK/shadow-journal.txt"
grep -q "DB_MODE=READ_ONLY" "$WORK/shadow-journal.txt"
grep -q "CUSTOMER_SYNC_V2_SHADOW=PASS" "$WORK/shadow-journal.txt"
echo "SYSTEMD_SHADOW_ONE_SHOT=PASS"

say "6. Enable five-minute shadow timer"
systemctl enable --now "$TIMER_NAME"

echo "SHADOW_TIMER_ACTIVE=$(systemctl is-active "$TIMER_NAME" || true)"
echo "SHADOW_TIMER_ENABLED=$(systemctl is-enabled "$TIMER_NAME" || true)"
test "$(systemctl is-active "$TIMER_NAME")" = "active"
test "$(systemctl is-enabled "$TIMER_NAME")" = "enabled"

say "7. Isolation gates"
test "$(systemctl is-active xpayments-customer-sync.timer)" = "active"
test "$(systemctl is-active xpay-xpayments-transaction-sync.timer 2>/dev/null || true)" != "active"

PAYMENT_HASH_AFTER="$(payment_runtime_hash)"
echo "PAYMENT_RUNTIME_HASH_AFTER=${PAYMENT_HASH_AFTER}"
test "$PAYMENT_HASH_BEFORE" = "$PAYMENT_HASH_AFTER"

echo "CUSTOMER_V1_TIMER_ACTIVE=$(systemctl is-active xpayments-customer-sync.timer || true)"
echo "XPAY_EXPERT_TX_TIMER_ACTIVE=$(systemctl is-active xpay-xpayments-transaction-sync.timer 2>/dev/null || true)"

say "8. Final API health"
health_gate

DEPLOY_STARTED=0
trap - ERR

echo
echo "CUSTOMER_SYNC_V2_SHADOW_TIMER_INSTALL=PASS"
echo "CUSTOMER_V1_UNCHANGED=PASS"
echo "PAYMENT_RUNTIME_UNCHANGED=PASS"
echo "DB_MODE=READ_ONLY"
echo "PAYMENT_CREATED=NO"
echo "SOURCE_COMMIT=${SOURCE_COMMIT}"
echo "ROLLBACK_BACKUP=${BACKUP}"
