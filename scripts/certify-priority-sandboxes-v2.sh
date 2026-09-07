#!/usr/bin/env bash
set -Eeuo pipefail

CONTAINER="xpayments-api-v3"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
REPORT="/root/xpayments-priority-sandboxes-v2-${STAMP}.txt"
TEST_PHONE="+351911111117"

exec > >(tee -a "$REPORT") 2>&1

echo "======================================================"
echo " XPAYMENTS — PRIORITY SANDBOX CERTIFICATION V2"
echo "======================================================"

echo
echo "=== 0. HEALTH ==="
curl -fsS https://api.xpayments.digital/api/health >/tmp/xp-priority-health.json
cat /tmp/xp-priority-health.json
printf '\n'
python3 - <<'PY'
import json
x=json.load(open('/tmp/xp-priority-health.json'))
assert x.get('status') == 'ONLINE', x
assert x.get('engine') == 'XPayments', x
print('PRE_HEALTH=PASS')
PY

certify_store() {
  local STORE_CODE="$1"
  local EXPECTED_STORE_ID="$2"
  local EXPECTED_PROVIDER="$3"
  local LABEL="$4"
  local SLUG="$5"
  local REF="${SLUG}-SBX-MBWAY-${STAMP}"

  echo
  echo "======================================================"
  echo " CERTIFY ${STORE_CODE}"
  echo "======================================================"

  local BINDING_JSON
  local BINDING_RC=0

  BINDING_JSON="$(docker exec \
    -e STORE_CODE="$STORE_CODE" \
    -e EXPECTED_STORE_ID="$EXPECTED_STORE_ID" \
    -e EXPECTED_PROVIDER="$EXPECTED_PROVIDER" \
    "$CONTAINER" \
    sh -lc 'cd /app && DATABASE_URL="$DIRECT_URL" NODE_PATH=/app/node_modules node' <<'NODE'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const rows = await prisma.$queryRawUnsafe(`
    select
      s.id::text as store_id,
      s.store_code,
      s.name as store_name,
      s.status as store_status,
      s.merchant_id::text as merchant_id,
      a.id::text as api_key_id,
      a.key as api_key,
      a.environment as api_key_environment,
      a.scopes as api_key_scopes,
      g.id::text as vault_id,
      g.provider,
      g.is_active as vault_active,
      g.merchant_id::text as vault_merchant_id,
      g.store_id::text as vault_store_id,
      case
        when g.credentials->>'secretKey' like 'sk_test_%'
          or g.credentials->>'secretKey' like 'rk_test_%'
        then true else false
      end as vault_test_mode,
      case
        when g.credentials->>'webhookSecret' like 'whsec_%'
        then true else false
      end as webhook_ready
    from public.stores s
    left join lateral (
      select *
      from public.api_keys ak
      where ak.store_id = s.id
        and ak.environment = 'test'
        and ak.scopes @> array['payments_write']::text[]
      order by ak.created_at desc
      limit 1
    ) a on true
    left join lateral (
      select *
      from public.gateway_vaults gv
      where gv.store_id = s.id
        and lower(gv.provider) = lower($2)
        and gv.is_active = true
      order by gv.created_at desc
      limit 1
    ) g on true
    where s.store_code = $1
    limit 1
  `, process.env.STORE_CODE, process.env.EXPECTED_PROVIDER);

  const r = rows?.[0];
  if (!r) throw new Error('STORE_NOT_FOUND');
  if (r.store_id !== process.env.EXPECTED_STORE_ID) throw new Error(`STORE_ID_MISMATCH:${r.store_id}`);
  if (r.store_status !== 'active') throw new Error(`STORE_NOT_ACTIVE:${r.store_status}`);
  if (!r.api_key) throw new Error('TEST_PAYMENTS_WRITE_KEY_NOT_FOUND');
  if (r.api_key_environment !== 'test') throw new Error(`API_KEY_ENV_INVALID:${r.api_key_environment}`);
  if (!r.vault_id) throw new Error('EXPECTED_ACTIVE_VAULT_NOT_FOUND');
  if (String(r.provider || '').toLowerCase() !== process.env.EXPECTED_PROVIDER.toLowerCase()) throw new Error(`PROVIDER_MISMATCH:${r.provider}`);
  if (r.vault_store_id !== r.store_id) throw new Error(`VAULT_STORE_MISMATCH:${r.vault_store_id}`);
  if (r.vault_merchant_id !== r.merchant_id) throw new Error(`VAULT_MERCHANT_MISMATCH:${r.vault_merchant_id}`);
  if (r.vault_test_mode !== true) throw new Error('VAULT_NOT_TEST_MODE');
  if (r.webhook_ready !== true) throw new Error('WEBHOOK_SECRET_MISSING');

  process.stdout.write(JSON.stringify({
    apiKey: r.api_key,
    storeId: r.store_id,
    storeName: r.store_name,
    merchantId: r.merchant_id,
    vaultId: r.vault_id,
    provider: r.provider
  }));
})()
.catch(err => {
  console.error('BINDING_ERROR=' + (err?.message || String(err)));
  process.exitCode = 1;
})
.finally(() => prisma.$disconnect());
NODE
  )" || BINDING_RC=$?

  if [ "$BINDING_RC" != "0" ]; then
    echo "STORE_BINDING=FAIL"
    echo "BINDING_RC=$BINDING_RC"
    return "$BINDING_RC"
  fi

  printf '%s' "$BINDING_JSON" >"/tmp/xp-${SLUG}-binding.json"

  local API_KEY STORE_ID STORE_NAME MERCHANT_ID VAULT_ID PROVIDER
  API_KEY="$(python3 - "$SLUG" <<'PY'
import json,sys
x=json.load(open(f'/tmp/xp-{sys.argv[1]}-binding.json'))
print(x['apiKey'])
PY
)"
  STORE_ID="$(python3 - "$SLUG" <<'PY'
import json,sys
x=json.load(open(f'/tmp/xp-{sys.argv[1]}-binding.json'))
print(x['storeId'])
PY
)"
  STORE_NAME="$(python3 - "$SLUG" <<'PY'
import json,sys
x=json.load(open(f'/tmp/xp-{sys.argv[1]}-binding.json'))
print(x['storeName'])
PY
)"
  MERCHANT_ID="$(python3 - "$SLUG" <<'PY'
import json,sys
x=json.load(open(f'/tmp/xp-{sys.argv[1]}-binding.json'))
print(x['merchantId'])
PY
)"
  VAULT_ID="$(python3 - "$SLUG" <<'PY'
import json,sys
x=json.load(open(f'/tmp/xp-{sys.argv[1]}-binding.json'))
print(x['vaultId'])
PY
)"
  PROVIDER="$(python3 - "$SLUG" <<'PY'
import json,sys
x=json.load(open(f'/tmp/xp-{sys.argv[1]}-binding.json'))
print(x['provider'])
PY
)"

  [ -n "$API_KEY" ]
  [ "$STORE_ID" = "$EXPECTED_STORE_ID" ]
  [ "$PROVIDER" = "$EXPECTED_PROVIDER" ]

  echo "STORE_BINDING=PASS"
  echo "STORE_ID=$STORE_ID"
  echo "STORE_NAME=$STORE_NAME"
  echo "PROVIDER=$PROVIDER"
  echo "API_KEY_SECRET_PRINTED=NO"
  echo "REFERENCE=$REF"

  local CREATE_HTTP
  CREATE_HTTP="$(curl -sS \
    -o "/tmp/xp-${SLUG}-create.json" \
    -w '%{http_code}' \
    -X POST https://api.xpayments.digital/api/v1/checkout/session \
    -H "Authorization: Bearer ${API_KEY}" \
    -H 'Content-Type: application/json' \
    -d "{\"amount\":500,\"currency\":\"EUR\",\"reference\":\"${REF}\",\"customerEmail\":\"${SLUG}-sandbox@example.com\",\"returnUrl\":\"https://example.com/payment-complete\",\"metadata\":{\"customerName\":\"${LABEL} Sandbox\",\"description\":\"XPayments ${LABEL} Sandbox Certification\"}}")"

  if [ "$CREATE_HTTP" != "201" ]; then
    echo "SESSION_CREATE=FAIL"
    echo "SESSION_CREATE_HTTP=$CREATE_HTTP"
    cat "/tmp/xp-${SLUG}-create.json"
    return 1
  fi

  local SESSION_ID
  SESSION_ID="$(python3 - "$SLUG" <<'PY'
import json,sys
x=json.load(open(f'/tmp/xp-{sys.argv[1]}-create.json'))
assert x.get('success') is True, x
d=x.get('data') or {}
assert d.get('sessionId') and d.get('checkoutUrl') and d.get('embedUrl'), d
print(d['sessionId'])
PY
)"

  echo "CHECKOUT_SESSION_CREATE=PASS"
  echo "SESSION_ID=$SESSION_ID"
  echo "CHECKOUT_URL=https://checkout.xpayments.digital/pay/${SESSION_ID}"
  echo "EMBED_URL=https://checkout.xpayments.digital/embed/${SESSION_ID}"

  curl -fsS "https://api.xpayments.digital/api/v1/checkout/session/${SESSION_ID}" >"/tmp/xp-${SLUG}-load.json"

  python3 - "$SLUG" "$EXPECTED_STORE_ID" <<'PY'
import json,sys
slug=sys.argv[1]
expected_store=sys.argv[2]
x=json.load(open(f'/tmp/xp-{slug}-load.json'))
assert x.get('success') is True, x
d=x.get('data') or {}
assert d.get('storeId') == expected_store, d
assert d.get('status') == 'pending', d
assert float(d.get('amount')) == 5.0, d
assert d.get('currency') == 'EUR', d
methods={m.get('code') for m in d.get('paymentMethods',[])}
for required in ('card','mb_way','bizum','multibanco'):
    assert required in methods, (required, methods)
print('CHECKOUT_SESSION_LOAD=PASS')
print('CHECKOUT_METHODS=PASS')
PY

  docker exec -e REF="$REF" "$CONTAINER" sh -lc 'cd /app && DATABASE_URL="$DIRECT_URL" NODE_PATH=/app/node_modules node' <<'NODE'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const rows = await prisma.$queryRawUnsafe('select count(*)::int as count from public.transactions where reference=$1', process.env.REF);
  const count = rows?.[0]?.count ?? -1;
  if (count !== 0) throw new Error(`PREINIT_TRANSACTION_EXISTS:${count}`);
  console.log('PREINIT_TRANSACTION_COUNT=0');
})().finally(() => prisma.$disconnect());
NODE

  local INIT_HTTP
  INIT_HTTP="$(curl -sS \
    -o "/tmp/xp-${SLUG}-init.json" \
    -w '%{http_code}' \
    -X POST https://api.xpayments.digital/api/v1/checkout/initiate \
    -H 'Content-Type: application/json' \
    -d "{\"sessionId\":\"${SESSION_ID}\",\"paymentMethod\":\"mb_way\",\"returnUrl\":\"https://checkout.xpayments.digital/pay/${SESSION_ID}?return=1\",\"customer\":{\"name\":\"${LABEL} Sandbox\",\"email\":\"${SLUG}-sandbox@example.com\",\"phone\":\"${TEST_PHONE}\"}}")"

  echo "INIT_HTTP=$INIT_HTTP"
  if [ "$INIT_HTTP" != "200" ]; then
    echo "CHECKOUT_INITIATE_MBWAY=FAIL"
    cat "/tmp/xp-${SLUG}-init.json"
    return 1
  fi

  local TX_ID
  TX_ID="$(python3 - "$SLUG" <<'PY'
import json,sys
x=json.load(open(f'/tmp/xp-{sys.argv[1]}-init.json'))
assert x.get('success') is True, x
d=x.get('data') or {}
assert d.get('transactionId'), d
assert d.get('method') == 'mb_way', d
print(d['transactionId'])
PY
)"

  echo "CHECKOUT_INITIATE_MBWAY=PASS"
  echo "TRANSACTION_ID=$TX_ID"

  local FINAL_STATUS="pending"
  for _ in $(seq 1 30); do
    curl -fsS "https://api.xpayments.digital/api/v1/checkout/session/${SESSION_ID}" >"/tmp/xp-${SLUG}-poll.json"
    FINAL_STATUS="$(python3 - "$SLUG" <<'PY'
import json,sys
x=json.load(open(f'/tmp/xp-{sys.argv[1]}-poll.json'))
print((x.get('data') or {}).get('status','unknown'))
PY
)"
    [ "$FINAL_STATUS" = "succeeded" ] && break
    { [ "$FINAL_STATUS" = "failed" ] || [ "$FINAL_STATUS" = "expired" ]; } && break
    sleep 2
  done

  echo "CHECKOUT_FINAL_STATUS=$FINAL_STATUS"
  if [ "$FINAL_STATUS" != "succeeded" ]; then
    echo "CHECKOUT_STATUS_RECONCILIATION=FAIL"
    return 1
  fi
  echo "CHECKOUT_STATUS_RECONCILIATION=PASS"

  docker exec \
    -e TX_ID="$TX_ID" \
    -e SESSION_ID="$SESSION_ID" \
    -e STORE_ID="$STORE_ID" \
    -e MERCHANT_ID="$MERCHANT_ID" \
    -e VAULT_ID="$VAULT_ID" \
    -e PROVIDER="$PROVIDER" \
    "$CONTAINER" \
    sh -lc 'cd /app && DATABASE_URL="$DIRECT_URL" NODE_PATH=/app/node_modules node' <<'NODE'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const txRows = await prisma.$queryRawUnsafe(`
    select id::text, merchant_id::text, store_id::text, gateway_vault_id::text,
           gateway, amount, currency, method, status
    from public.transactions where id=$1::uuid
  `, process.env.TX_ID);
  const sRows = await prisma.$queryRawUnsafe(`
    select id::text, status from public.checkout_sessions where id=$1::uuid
  `, process.env.SESSION_ID);
  const tx = txRows?.[0];
  const session = sRows?.[0];
  if (!tx || !session) throw new Error('FINAL_RECORD_MISSING');
  if (tx.store_id !== process.env.STORE_ID) throw new Error(`STORE_BINDING_MISMATCH:${tx.store_id}`);
  if (tx.merchant_id !== process.env.MERCHANT_ID) throw new Error(`MERCHANT_BINDING_MISMATCH:${tx.merchant_id}`);
  if (tx.gateway_vault_id !== process.env.VAULT_ID) throw new Error(`VAULT_BINDING_MISMATCH:${tx.gateway_vault_id}`);
  if (String(tx.gateway || '').toLowerCase() !== process.env.PROVIDER.toLowerCase()) throw new Error(`PROVIDER_MISMATCH:${tx.gateway}`);
  if (Number(tx.amount) !== 5 || tx.currency !== 'EUR' || tx.method !== 'mb_way' || tx.status !== 'succeeded') {
    throw new Error(`FINAL_TRANSACTION_INVALID:${tx.amount}:${tx.currency}:${tx.method}:${tx.status}`);
  }
  if (session.status !== 'succeeded') throw new Error(`SESSION_STATUS_INVALID:${session.status}`);
  const movements = await prisma.$queryRawUnsafe(
    'select count(*)::int as count from public.wallet_movements where reference=$1',
    process.env.TX_ID
  );
  const count = movements?.[0]?.count ?? 0;
  if (count < 1) throw new Error(`WALLET_MOVEMENT_MISSING:${count}`);
  console.log('TRANSACTION_STORE_BINDING=PASS');
  console.log('TRANSACTION_MERCHANT_BINDING=PASS');
  console.log('TRANSACTION_VAULT_BINDING=PASS');
  console.log('TRANSACTION_PROVIDER_BINDING=PASS');
  console.log('TRANSACTION_SUCCEEDED=PASS');
  console.log('WALLET_MOVEMENT=PASS');
})()
.catch(err => {
  console.error('FINAL_ASSERT_ERROR=' + (err?.message || String(err)));
  process.exitCode = 1;
})
.finally(() => prisma.$disconnect());
NODE

  echo "${STORE_CODE}_SANDBOX_E2E=PASS"
  unset API_KEY
}

certify_store "RDEURO-XPAY-SANDBOX" "e933a26b-7ea1-4e32-a268-ebb2d01c326c" "stripe-rdeuro-xpay-sandbox" "RDEuro" "rdeuro"
certify_store "MADOSI-XPAY-SANDBOX" "02e0731c-c9be-4f93-83af-10470a7eeb17" "stripe-madosi-xpay-sandbox" "Madosi" "madosi"
certify_store "HUMANIMPACT-XPAY-SANDBOX" "fa995cc2-87a8-4eb2-bbe5-b65cd9e25777" "stripe-humanimpact-xpay-sandbox" "HumanImpact" "humanimpact"

echo
echo "=== FINAL HEALTH ==="
curl -fsS https://api.xpayments.digital/api/health >/tmp/xp-priority-final-health.json
cat /tmp/xp-priority-final-health.json
printf '\n'
python3 - <<'PY'
import json
x=json.load(open('/tmp/xp-priority-final-health.json'))
assert x.get('status') == 'ONLINE', x
assert x.get('engine') == 'XPayments', x
print('FINAL_HEALTH=PASS')
PY

echo
echo "PRIORITY_SANDBOX_CERTIFICATION=PASS"
echo "REPORT=$REPORT"
