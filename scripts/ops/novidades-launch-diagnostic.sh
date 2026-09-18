#!/usr/bin/env bash
set -Eeuo pipefail

API_ORIGIN="${API_ORIGIN:-https://api.xpayments.digital}"
APP_DIR="${APP_DIR:-/root/xpayments-backend-v3}"
EXPECTED_PORT="${EXPECTED_PORT:-8084}"

hr() {
  printf '\n======================================================\n%s\n======================================================\n' "$1"
}

safe_cmd() {
  "$@" 2>&1 || true
}

hr "1. Host / clock / capacity"
date -Is
uname -a
printf '\nDisk:\n'
df -h / | tail -n +1
printf '\nMemory:\n'
free -h || true
printf '\nLoad:\n'
uptime || true

hr "2. Public XPAYMENTS health"
HEALTH_CODE="$(curl -sS -o /tmp/novidades-health.json -w '%{http_code}' --max-time 10 "${API_ORIGIN}/api/health" || true)"
printf 'HTTP=%s\n' "$HEALTH_CODE"
cat /tmp/novidades-health.json 2>/dev/null || true
echo

hr "3. Repository state"
if [ -d "${APP_DIR}/.git" ]; then
  printf 'APP_DIR=%s\n' "$APP_DIR"
  printf 'HEAD='
  git -C "$APP_DIR" rev-parse HEAD || true
  printf 'BRANCH='
  git -C "$APP_DIR" branch --show-current || true
  printf 'REMOTE='
  git -C "$APP_DIR" remote get-url origin 2>/dev/null || true
  printf '\nWorking tree:\n'
  git -C "$APP_DIR" status --short || true
  printf '\nRecent commits:\n'
  git -C "$APP_DIR" log -5 --oneline --decorate || true
else
  echo "Repository not found at ${APP_DIR}"
fi

hr "4. Docker runtime"
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null || true

CONTAINER_ID="$(
  docker ps --format '{{.ID}} {{.Names}} {{.Ports}}' 2>/dev/null |
    awk -v port=":${EXPECTED_PORT}->" 'index($0,port){print $1; exit}'
)"

if [ -z "$CONTAINER_ID" ]; then
  CONTAINER_ID="$(
    docker ps --format '{{.ID}} {{.Names}}' 2>/dev/null |
      awk 'tolower($0) ~ /xpayments|payment-api/{print $1; exit}'
  )"
fi

if [ -n "$CONTAINER_ID" ]; then
  CONTAINER_NAME="$(docker inspect -f '{{.Name}}' "$CONTAINER_ID" 2>/dev/null | sed 's#^/##')"
  IMAGE="$(docker inspect -f '{{.Config.Image}}' "$CONTAINER_ID" 2>/dev/null || true)"
  printf '\nDetected container: %s\nImage: %s\n' "$CONTAINER_NAME" "$IMAGE"

  printf '\nRelevant environment VARIABLE NAMES only (values redacted):\n'
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$CONTAINER_ID" 2>/dev/null |
    sed -E 's/=.*$/=<redacted>/' |
    grep -Ei 'DATABASE|DIRECT_URL|REDIS|PIX|MISTIC|PAYMENT|WEBHOOK|PORT|NODE_ENV|STRIPE' |
    sort || true
else
  echo "No running XPAYMENTS container detected."
fi

hr "5. Listening ports / proxy"
safe_cmd ss -ltnp | grep -E ":(80|443|${EXPECTED_PORT})\b" || true
printf '\nCaddy status/version:\n'
safe_cmd systemctl is-active caddy
safe_cmd caddy version

hr "6. PIX route surface"
printf 'Unauthenticated POST /api/v1/payments/charge should NOT create a payment.\n'
ROUTE_CODE="$(
  curl -sS -o /tmp/novidades-charge-probe.json -w '%{http_code}' \
    --max-time 10 \
    -H 'content-type: application/json' \
    -d '{"amount":1,"currency":"BRL","payment_method_types":["pix"],"reference":"NOV-DIAGNOSTIC-NOAUTH"}' \
    "${API_ORIGIN}/api/v1/payments/charge" || true
)"
printf 'HTTP=%s\n' "$ROUTE_CODE"
cat /tmp/novidades-charge-probe.json 2>/dev/null || true
echo

hr "7. PIX source/runtime capability"
if [ -d "$APP_DIR" ]; then
  for file in \
    src/modules/payments/controllers/pix.controller.ts \
    src/modules/payments/services/pix-router.service.ts \
    src/modules/payments/services/misticpay.service.ts \
    src/modules/payments/services/pixgo.service.ts
  do
    if [ -f "${APP_DIR}/${file}" ]; then
      echo "FOUND  ${file}"
    else
      echo "MISSING ${file}"
    fi
  done

  printf '\nRoute references:\n'
  grep -Rns --include='*.ts' \
    -E "payments/charge|payment_method_types|pix.controller|pixRouter" \
    "${APP_DIR}/src/modules/payments" 2>/dev/null |
    head -n 40 || true
fi

hr "8. Docker compose / service identity"
if [ -d "$APP_DIR" ]; then
  (
    cd "$APP_DIR"
    if command -v docker >/dev/null 2>&1; then
      docker compose config --services 2>/dev/null || true
    fi
  )
fi

hr "9. Optional recent sanitized logs"
if [ "${SHOW_LOGS:-0}" = "1" ] && [ -n "${CONTAINER_ID:-}" ]; then
  docker logs --since 20m --tail 250 "$CONTAINER_ID" 2>&1 |
    sed -E \
      -e 's/((api[_-]?key|secret|token|authorization)[\" ]*[:=][\" ]*)[^\" ,}]+/\1<redacted>/Ig' \
      -e 's/([0-9]{3}\.?[0-9]{3}\.?[0-9]{3}-?[0-9]{2})/<cpf-redacted>/g' |
    tail -n 250 || true
else
  echo "Skipped. Re-run with SHOW_LOGS=1 only if log inspection is needed."
fi

hr "10. Diagnostic summary"
echo "Capture this complete output and return it to the project chat."
echo "This script does not print API key/secret values and does not create an authenticated payment."
