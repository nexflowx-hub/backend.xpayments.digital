#!/usr/bin/env bash
set -Eeuo pipefail

CONTAINER="xpayments-api-v3"
API="https://api.xpayments.digital"
CHECKOUT="https://checkout.xpayments.digital"
PREVIEW="https://checkout-xpayments-digit-git-b4fc16-nexflowxtech-1189s-projects.vercel.app"
TEST_PHONE="+351911111117"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
START_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
REPORT="/root/xpayments-channel-cert-${STAMP}.txt"

exec > >(tee -a "$REPORT") 2>&1

fail() {
  echo "FAIL_STAGE=$1"
  exit 1
}

health() {
  curl -fsS "$API/api/health" >/tmp/xp-channel-health.json || return 1
  python3 - <<'PY'
import json
x=json.load(open('/tmp/xp-channel-health.json'))
assert x.get('status') == 'ONLINE', x
assert x.get('engine') == 'XPayments', x
PY
}

get_binding() {
  local store_code="$1"
  local expected_provider="$2"

  docker exec -i \
    -e STORE_CODE="$store_code" \
    -e EXPECTED_PROVIDER="$expected_provider" \
    "$CONTAINER" \
    sh -lc 'cd /app && DATABASE_URL="$DIRECT_URL" NODE_PATH=/app/node_modules node' <<'NODE'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const rows = await prisma.$queryRawUnsafe(`
    select
      s.id::text as store_id,
      s.merchant_id::text as merchant_id,
      s.status as store_status,
      a.key as api_key,
      a.environment,
      g.id::text as vault_id,
      g.provider,
      g.is_active,
      case when g.credentials->>'secretKey' like 'sk_test_%'
             or g.credentials->>'secretKey' like 'rk_test_%'
           then true else false end as test_mode
    from public.stores s
    left join lateral (
      select ak.* from public.api_keys ak
      where ak.store_id=s.id
        and ak.environment='test'
        and ak.scopes @> array['payments_write']::text[]
      order by ak.created_at desc limit 1
    ) a on true
    left join lateral (
      select gv.* from public.gateway_vaults gv
      where gv.store_id=s.id
        and lower(gv.provider)=lower($2)
        and gv.is_active=true
      order by gv.created_at desc limit 1
    ) g on true
    where s.store_code=$1 limit 1
  `, process.env.STORE_CODE, process.env.EXPECTED_PROVIDER);

  const r=rows?.[0];
  if (!r) throw new Error('STORE_NOT_FOUND');
  if (r.store_status !== 'active') throw new Error('STORE_NOT_ACTIVE');
  if (!r.api_key || r.environment !== 'test') throw new Error('TEST_KEY_NOT_FOUND');
  if (!r.vault_id || !r.is_active) throw new Error('ACTIVE_VAULT_NOT_FOUND');
  if (String(r.provider).toLowerCase() !== process.env.EXPECTED_PROVIDER.toLowerCase()) throw new Error('PROVIDER_MISMATCH');
  if (r.test_mode !== true) throw new Error('VAULT_NOT_TEST');

  process.stdout.write([
    r.api_key,
    r.store_id,
    r.merchant_id,
    r.vault_id,
    r.provider
  ].join('\t'));
})()
.catch(e => {
  console.error('BINDING_ERROR=' + (e?.message || String(e)));
  process.exitCode=1;
})
.finally(() => prisma.$disconnect());
NODE
}

poll_tx() {
  local tx_id="$1"
  local expected_store="$2"
  local expected_vault="$3"
  local expected_provider="$4"
  local max="${5:-50}"

  local i state status movements store vault provider
  for i in $(seq 1 "$max"); do
    state="$(docker exec -i \
      -e TX_ID="$tx_id" \
      "$CONTAINER" \
      sh -lc 'cd /app && DATABASE_URL="$DIRECT_URL" NODE_PATH=/app/node_modules node' <<'NODE' 2>/tmp/xp-poll-error.log || true
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const rows=await prisma.$queryRawUnsafe(`
    select t.status,
           t.store_id::text as store_id,
           t.gateway_vault_id::text as vault_id,
           t.gateway,
           (select count(*)::int from public.wallet_movements wm where wm.reference=t.id::text) as movements
    from public.transactions t where t.id=$1::uuid
  `, process.env.TX_ID);
  const r=rows?.[0];
  if (!r) { process.stdout.write('MISSING'); return; }
  process.stdout.write([r.status,r.movements,r.store_id,r.vault_id,r.gateway].join('\t'));
})().finally(() => prisma.$disconnect());
NODE
)"

    if [ -z "$state" ]; then
      echo "TX_POLL_${i}=DB_RETRY"
      sleep 2
      continue
    fi

    IFS=$'\t' read -r status movements store vault provider <<< "$state"
    echo "TX_POLL_${i}=${status}:wallet=${movements}"

    if [ "$status" = "succeeded" ] && [ "${movements:-0}" -ge 1 ]; then
      [ "$store" = "$expected_store" ] || fail "TX_STORE_BINDING"
      [ "$vault" = "$expected_vault" ] || fail "TX_VAULT_BINDING"
      [ "$provider" = "$expected_provider" ] || fail "TX_PROVIDER_BINDING"
      return 0
    fi

    if [ "$status" = "failed" ] || [ "$status" = "canceled" ] || [ "$status" = "cancelled" ]; then
      return 2
    fi

    sleep 2
  done

  return 1
}

poll_session() {
  local session_id="$1"
  local max="${2:-50}"
  local i status

  for i in $(seq 1 "$max"); do
    if ! curl -fsS "$API/api/v1/checkout/session/$session_id" >/tmp/xp-session-poll.json; then
      echo "SESSION_POLL_${i}=HTTP_RETRY"
      sleep 2
      continue
    fi

    status="$(python3 - <<'PY'
import json
x=json.load(open('/tmp/xp-session-poll.json'))
print((x.get('data') or {}).get('status','unknown'))
PY
)"

    echo "SESSION_POLL_${i}=${status}"
    [ "$status" = "succeeded" ] && return 0
    { [ "$status" = "failed" ] || [ "$status" = "expired" ]; } && return 2
    sleep 2
  done

  return 1
}

echo "======================================================"
echo " XPAYMENTS — CHANNEL CERTIFICATION V1"
echo "======================================================"

echo
echo "=== 0. HEALTH ==="
health || fail "PRE_HEALTH"
cat /tmp/xp-channel-health.json
echo
echo "PRE_HEALTH=PASS"

echo
echo "=== 1. RDEURO BINDING ==="
RDE_BINDING="$(get_binding 'RDEURO-XPAY-SANDBOX' 'stripe-rdeuro-xpay-sandbox')" || fail "RDE_BINDING"
IFS=$'\t' read -r RDE_KEY RDE_STORE RDE_MERCHANT RDE_VAULT RDE_PROVIDER <<< "$RDE_BINDING"
[ -n "$RDE_KEY" ] || fail "RDE_KEY_EMPTY"
echo "RDEURO_BINDING=PASS"
echo "RDEURO_STORE_ID=$RDE_STORE"
echo "RDEURO_VAULT_ID=$RDE_VAULT"
echo "RDEURO_PROVIDER=$RDE_PROVIDER"
echo "API_KEY_SECRET_PRINTED=NO"

echo
echo "======================================================"
echo " 2. S2S — RDEURO /payments/charge"
echo "======================================================"
S2S_REF="RDEURO-S2S-CERT-${STAMP}"
S2S_HTTP="$(curl -sS -o /tmp/xp-s2s.json -w '%{http_code}' \
  -X POST "$API/api/v1/payments/charge" \
  -H "Authorization: Bearer $RDE_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"amount\":500,\"currency\":\"EUR\",\"payment_method_types\":[\"mb_way\"],\"reference\":\"$S2S_REF\",\"customer\":{\"name\":\"RDEuro S2S Certification\",\"email\":\"rdeuro-s2s-cert@example.com\",\"phone\":\"$TEST_PHONE\"},\"metadata\":{\"order_id\":\"$S2S_REF\",\"certification\":\"s2s\"}}")"

echo "S2S_HTTP=$S2S_HTTP"
if [ "$S2S_HTTP" != "200" ]; then
  cat /tmp/xp-s2s.json
  fail "S2S_INITIATE"
fi

S2S_TX="$(python3 - <<'PY'
import json
x=json.load(open('/tmp/xp-s2s.json'))
assert x.get('success') is True, x
assert x.get('transactionId'), x
assert x.get('providerId'), x
print(x['transactionId'])
PY
)" || fail "S2S_RESPONSE_PARSE"

echo "S2S_INITIATE=PASS"
echo "S2S_TRANSACTION_ID=$S2S_TX"
echo "S2S_REFERENCE=$S2S_REF"

if poll_tx "$S2S_TX" "$RDE_STORE" "$RDE_VAULT" "$RDE_PROVIDER" 55; then
  echo "S2S_SIGNED_WEBHOOK_SETTLEMENT=PASS"
  echo "S2S_WALLET_MOVEMENT=PASS"
else
  RC=$?
  echo "S2S_FINAL_RC=$RC"
  docker logs --since "$START_ISO" "$CONTAINER" 2>&1 | tail -n 250
  fail "S2S_SETTLEMENT"
fi

echo
echo "======================================================"
echo " 3. HOSTED CHECKOUT — RDEURO"
echo "======================================================"
HOST_REF="RDEURO-HOSTED-CERT-${STAMP}"
CREATE_HTTP="$(curl -sS -o /tmp/xp-host-create.json -w '%{http_code}' \
  -X POST "$API/api/v1/checkout/session" \
  -H "Authorization: Bearer $RDE_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"amount\":500,\"currency\":\"EUR\",\"reference\":\"$HOST_REF\",\"customerEmail\":\"rdeuro-hosted-cert@example.com\",\"returnUrl\":\"https://xpayments.digital/payment-complete\",\"expiresInMinutes\":30,\"metadata\":{\"customerName\":\"RDEuro Hosted Certification\",\"description\":\"Certificação Checkout Hosted XPayments\",\"checkoutDisplayName\":\"RDEuro Secure Checkout\",\"primaryColor\":\"#0F172A\",\"theme\":\"light\",\"autoReturnSeconds\":3}}")"

echo "HOSTED_SESSION_HTTP=$CREATE_HTTP"
[ "$CREATE_HTTP" = "201" ] || { cat /tmp/xp-host-create.json; fail "HOSTED_SESSION_CREATE"; }

HOST_SESSION="$(python3 - <<'PY'
import json
x=json.load(open('/tmp/xp-host-create.json'))
d=x.get('data') or {}
assert x.get('success') is True and d.get('sessionId'), x
print(d['sessionId'])
PY
)" || fail "HOSTED_SESSION_PARSE"

echo "HOSTED_SESSION_CREATE=PASS"
echo "HOSTED_SESSION_ID=$HOST_SESSION"

curl -fsS "$API/api/v1/checkout/session/$HOST_SESSION" >/tmp/xp-host-load.json || fail "HOSTED_SESSION_LOAD_HTTP"
python3 - "$RDE_STORE" <<'PY'
import json,sys
x=json.load(open('/tmp/xp-host-load.json'))
d=x.get('data') or {}
assert x.get('success') is True, x
assert d.get('storeId') == sys.argv[1], d
assert d.get('storeName') == 'RDEuro Secure Checkout', d
assert d.get('primaryColor') == '#0F172A', d
assert d.get('theme') == 'light', d
assert d.get('description') == 'Certificação Checkout Hosted XPayments', d
methods={m.get('code') for m in d.get('paymentMethods',[])}
assert 'mb_way' in methods and 'card' in methods, methods
print('HOSTED_PERSONALIZATION_API=PASS')
print('HOSTED_METHODS_API=PASS')
PY

HOSTED_PAGE_HTTP="$(curl -sS -o /dev/null -w '%{http_code}' "$CHECKOUT/pay/$HOST_SESSION")"
EMBED_PAGE_HTTP="$(curl -sS -o /dev/null -w '%{http_code}' "$CHECKOUT/embed/$HOST_SESSION?parent_origin=https%3A%2F%2Fxpayments.digital")"
echo "HOSTED_PAGE_HTTP=$HOSTED_PAGE_HTTP"
echo "EMBED_PAGE_HTTP=$EMBED_PAGE_HTTP"
[ "$HOSTED_PAGE_HTTP" = "200" ] || fail "HOSTED_PAGE_OPEN"
{ [ "$EMBED_PAGE_HTTP" = "200" ] || [ "$EMBED_PAGE_HTTP" = "307" ] || [ "$EMBED_PAGE_HTTP" = "308" ]; } || fail "EMBED_PAGE_OPEN"
echo "HOSTED_URL_ROUTE=PASS"
echo "EMBED_URL_ROUTE=PASS"

INIT_HTTP="$(curl -sS -o /tmp/xp-host-init.json -w '%{http_code}' \
  -X POST "$API/api/v1/checkout/initiate" \
  -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"$HOST_SESSION\",\"paymentMethod\":\"mb_way\",\"returnUrl\":\"$CHECKOUT/pay/$HOST_SESSION?return=1\",\"customer\":{\"name\":\"RDEuro Hosted Certification\",\"email\":\"rdeuro-hosted-cert@example.com\",\"phone\":\"$TEST_PHONE\"}}")"

echo "HOSTED_INIT_HTTP=$INIT_HTTP"
[ "$INIT_HTTP" = "200" ] || { cat /tmp/xp-host-init.json; fail "HOSTED_INITIATE"; }

HOST_TX="$(python3 - <<'PY'
import json
x=json.load(open('/tmp/xp-host-init.json'))
d=x.get('data') or {}
assert x.get('success') is True, x
assert d.get('transactionId'), d
print(d['transactionId'])
PY
)" || fail "HOSTED_INIT_PARSE"

echo "HOSTED_INITIATE=PASS"
echo "HOSTED_TRANSACTION_ID=$HOST_TX"

poll_session "$HOST_SESSION" 55 || {
  RC=$?
  echo "HOSTED_SESSION_FINAL_RC=$RC"
  docker logs --since "$START_ISO" "$CONTAINER" 2>&1 | tail -n 300
  fail "HOSTED_SESSION_SETTLEMENT"
}

echo "HOSTED_SESSION_SUCCEEDED=PASS"

poll_tx "$HOST_TX" "$RDE_STORE" "$RDE_VAULT" "$RDE_PROVIDER" 15 || {
  RC=$?
  echo "HOSTED_TX_FINAL_RC=$RC"
  fail "HOSTED_TX_ASSERT"
}

echo "HOSTED_TRANSACTION_BINDING=PASS"
echo "HOSTED_WALLET_MOVEMENT=PASS"

echo
echo "======================================================"
echo " 4. HUMANIMPACT — WHITE-LABEL UI SESSION"
echo "======================================================"
HI_BINDING="$(get_binding 'HUMANIMPACT-XPAY-SANDBOX' 'stripe-humanimpact-xpay-sandbox')" || fail "HI_BINDING"
IFS=$'\t' read -r HI_KEY HI_STORE HI_MERCHANT HI_VAULT HI_PROVIDER <<< "$HI_BINDING"
[ -n "$HI_KEY" ] || fail "HI_KEY_EMPTY"

HI_REF="HUMANIMPACT-UI-CERT-${STAMP}"
HI_HTTP="$(curl -sS -o /tmp/xp-hi-create.json -w '%{http_code}' \
  -X POST "$API/api/v1/checkout/session" \
  -H "Authorization: Bearer $HI_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"amount\":500,\"currency\":\"EUR\",\"reference\":\"$HI_REF\",\"customerEmail\":\"humanimpact-ui-cert@example.com\",\"returnUrl\":\"https://xpayments.digital/payment-complete\",\"allowedOrigin\":\"https://xpayments.digital\",\"expiresInMinutes\":60,\"metadata\":{\"customerName\":\"HumanImpact UI Certification\",\"description\":\"Pagamento seguro HumanImpact\"}}")"

[ "$HI_HTTP" = "201" ] || { cat /tmp/xp-hi-create.json; fail "HI_SESSION_CREATE"; }
HI_SESSION="$(python3 - <<'PY'
import json
x=json.load(open('/tmp/xp-hi-create.json'))
d=x.get('data') or {}
assert x.get('success') is True and d.get('sessionId'), x
print(d['sessionId'])
PY
)" || fail "HI_SESSION_PARSE"

curl -fsS "$API/api/v1/checkout/session/$HI_SESSION" >/tmp/xp-hi-load.json || fail "HI_LOAD"
python3 - "$HI_STORE" <<'PY'
import json,sys
x=json.load(open('/tmp/xp-hi-load.json'))
d=x.get('data') or {}
assert x.get('success') is True, x
assert d.get('storeId') == sys.argv[1], d
assert d.get('storeName') == 'HumanImpact', d
assert d.get('internalStoreName') == 'XPay Test - HumanImpact', d
assert d.get('primaryColor') == '#111111', d
assert d.get('theme') == 'light', d
assert d.get('localeMode') == 'auto', d
assert d.get('autoReturnSeconds') == 3, d
assert d.get('description') == 'Pagamento seguro HumanImpact', d
print('HUMANIMPACT_STORE_THEME=PASS')
print('HUMANIMPACT_DISPLAY_NAME=PASS')
print('HUMANIMPACT_PERSONALIZATION_API=PASS')
PY

echo "HUMANIMPACT_UI_SESSION=PASS"
echo "HUMANIMPACT_SESSION_ID=$HI_SESSION"
echo "PROD_HOSTED_URL=$CHECKOUT/pay/$HI_SESSION"
echo "PROD_EMBED_URL=$CHECKOUT/embed/$HI_SESSION?parent_origin=https%3A%2F%2Fxpayments.digital"
echo "V2_PREVIEW_HOSTED_URL=$PREVIEW/pay/$HI_SESSION"
echo "V2_PREVIEW_EMBED_URL=$PREVIEW/pay/$HI_SESSION?embedded=1&parent_origin=https%3A%2F%2Fxpayments.digital"
echo "NOTE=HUMANIMPACT_UI_SESSION_IS_NOT_INITIATED"

echo
echo "======================================================"
echo " 5. WEBHOOK SECURITY EVIDENCE"
echo "======================================================"
docker logs --since "$START_ISO" "$CONTAINER" 2>&1 \
  | grep -E "STRIPE WEBHOOK SHARED VAULT RESOLVED|STRIPE WEBHOOK VERIFIED|STRIPE WEBHOOK REJECTED|$S2S_TX|$HOST_TX" \
  | tail -n 220 || true

echo
echo "=== 6. FINAL HEALTH ==="
health || fail "FINAL_HEALTH"
cat /tmp/xp-channel-health.json
echo
echo "FINAL_HEALTH=PASS"

echo
echo "======================================================"
echo " S2S_RDEURO=PASS"
echo " CHECKOUT_RDEURO=PASS"
echo " HUMANIMPACT_PERSONALIZATION=PASS"
echo " CHANNEL_CERTIFICATION_CORE=PASS"
echo " REPORT=$REPORT"
echo "======================================================"
