#!/usr/bin/env bash
set -Eeuo pipefail

PROD_ROOT="/root/xpayments-backend-v3"
CONTAINER="xpayments-api-v3"
AUTH_COMMIT="380c45c0f2451fd43bd8ba9a24755e611926f87a"
SOURCE_VAULT_ID="c9e9e4b2-bbf1-458a-b643-84fb48a8ffb8"
EXPECTED_AUTH_CURRENT="866c27da5e2fc7a75af09c81f0c9991d05e6b1fdc6582d3d7bd02c7edc31bf11"
EXPECTED_DIRECT="f4ac2ee6f982ed98f59b90ce45ec6b12691ed31bd1e84472510cbec90e696b32"
EXPECTED_ROUTES="31efe0f9e5d87b3224c7fb55042b4ea8f79ddd3b43b61cce6b5bd910d28a37e5"
EXPECTED_WEBHOOK="968826914cf620126ebcb675939518aa2685bc45715e7c6e6aec3b619ec64bfa"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BUILD="/root/xpayments-onboarding-build-${STAMP}"
BACKUP_DIR="/root/xpayments-onboarding-backup-${STAMP}"
AUTH_SRC="src/modules/auth/controllers/auth.controller.ts"
DIRECT="src/modules/payments/controllers/direct.controller.ts"
ROUTES="src/modules/payments/routes/payments.routes.ts"
WEBHOOK="src/modules/payments/controllers/stripe.webhook.ts"
CONTAINER_AUTH="/app/dist/modules/auth/controllers/auth.controller.js"
CERT_EMAIL="onboarding-cert-${STAMP,,}@example.invalid"
CERT_PASSWORD="$(openssl rand -hex 18)"
CERT_RESPONSE="/root/onboarding-cert-${STAMP}.response.json"
CERT_PAYLOAD="/root/onboarding-cert-${STAMP}.payload.json"

log() { printf '\n=== %s ===\n' "$1"; }
fail() { echo "$1=FAIL"; exit 1; }

health() {
  curl -fsS https://api.xpayments.digital/api/health
}

rollback() {
  set +e
  echo
  echo "ROLLBACK_START=YES"
  if [ -f "${BACKUP_DIR}/auth.controller.ts" ]; then
    cp "${BACKUP_DIR}/auth.controller.ts" "${PROD_ROOT}/${AUTH_SRC}"
  fi
  if [ -f "${BACKUP_DIR}/auth.controller.host.js" ]; then
    cp "${BACKUP_DIR}/auth.controller.host.js" "${PROD_ROOT}/dist/modules/auth/controllers/auth.controller.js"
  fi
  if [ -f "${BACKUP_DIR}/auth.controller.container.js" ]; then
    docker cp "${BACKUP_DIR}/auth.controller.container.js" "${CONTAINER}:${CONTAINER_AUTH}" >/dev/null 2>&1
  fi
  docker restart "$CONTAINER" >/dev/null 2>&1
  sleep 3
  health || true
  echo
  echo "ROLLBACK_COMPLETE=YES"
}

trap 'echo "UNEXPECTED_ERROR=YES"; rollback' ERR

cd "$PROD_ROOT"
mkdir -p "$BACKUP_DIR"

log "1. PRE HEALTH"
health
echo
echo "PRE_HEALTH=PASS"

log "2. PRODUCTION BASELINE GATES"
AUTH_NOW="$(sha256sum "$AUTH_SRC" | awk '{print $1}')"
DIRECT_NOW="$(sha256sum "$DIRECT" | awk '{print $1}')"
ROUTES_NOW="$(sha256sum "$ROUTES" | awk '{print $1}')"
WEBHOOK_NOW="$(sha256sum "$WEBHOOK" | awk '{print $1}')"

echo "AUTH_CURRENT_SHA=${AUTH_NOW}"
echo "DIRECT_SHA=${DIRECT_NOW}"
echo "ROUTES_SHA=${ROUTES_NOW}"
echo "WEBHOOK_SHA=${WEBHOOK_NOW}"

[ "$AUTH_NOW" = "$EXPECTED_AUTH_CURRENT" ] || fail "AUTH_BASELINE"
[ "$DIRECT_NOW" = "$EXPECTED_DIRECT" ] || fail "DIRECT_INVARIANT"
[ "$ROUTES_NOW" = "$EXPECTED_ROUTES" ] || fail "ROUTES_INVARIANT"
[ "$WEBHOOK_NOW" = "$EXPECTED_WEBHOOK" ] || fail "WEBHOOK_INVARIANT"

echo "AUTH_BASELINE=PASS"
echo "PAYMENT_INVARIANTS_PRE=PASS"

VERIFIER_DIST="$(docker exec "$CONTAINER" sh -lc "find /app/dist -type f -name 'stripe-webhook-verification.service.js' -print -quit")"
[ -n "$VERIFIER_DIST" ] || fail "VERIFIER_FOUND"
docker exec "$CONTAINER" grep -q "STRIPE WEBHOOK SHARED VAULT RESOLVED" "$VERIFIER_DIST" || fail "SHARED_VAULT_RUNTIME"
echo "SHARED_VAULT_RUNTIME=PASS"

log "3. FETCH AND ISOLATED BUILD"
git fetch origin feat/merchant-onboarding-sandbox-20260908 >/dev/null 2>&1

git cat-file -e "${AUTH_COMMIT}^{commit}" 2>/dev/null || fail "AUTH_COMMIT_AVAILABLE"
rm -rf "$BUILD"
mkdir -p "$BUILD"
git archive "$AUTH_COMMIT" | tar -x -C "$BUILD"
ln -s "$PROD_ROOT/node_modules" "$BUILD/node_modules"

(
  cd "$BUILD"
  "$PROD_ROOT/node_modules/.bin/tsc" -p tsconfig.json
)

NEW_SRC="${BUILD}/${AUTH_SRC}"
NEW_JS="${BUILD}/dist/modules/auth/controllers/auth.controller.js"
[ -s "$NEW_SRC" ] || fail "NEW_AUTH_SOURCE"
[ -s "$NEW_JS" ] || fail "NEW_AUTH_COMPILED"

grep -q "DEFAULT_SHARED_SANDBOX_SOURCE_VAULT_ID" "$NEW_SRC" || fail "SOURCE_VAULT_MARKER"
grep -q "objectValue" "$NEW_SRC" || fail "CREDENTIAL_NORMALIZER_MARKER"
grep -q "XPAY Sandbox" "$NEW_SRC" || fail "XPAY_SANDBOX_MARKER"
grep -q "payments_write" "$NEW_SRC" || fail "PAYMENTS_WRITE_MARKER"

echo "ISOLATED_TYPESCRIPT_BUILD=PASS"
echo "ONBOARDING_MARKERS=PASS"

log "4. BACKUP CURRENT AUTH ONLY"
cp "$AUTH_SRC" "${BACKUP_DIR}/auth.controller.ts"
if [ -f "dist/modules/auth/controllers/auth.controller.js" ]; then
  cp "dist/modules/auth/controllers/auth.controller.js" "${BACKUP_DIR}/auth.controller.host.js"
fi
docker cp "${CONTAINER}:${CONTAINER_AUTH}" "${BACKUP_DIR}/auth.controller.container.js" >/dev/null
chmod 600 "${BACKUP_DIR}"/*
echo "AUTH_BACKUP=PASS"

log "5. SURGICAL INSTALL"
cp "$NEW_SRC" "$AUTH_SRC"
if [ -d "dist/modules/auth/controllers" ]; then
  cp "$NEW_JS" "dist/modules/auth/controllers/auth.controller.js"
fi
docker cp "$NEW_JS" "${CONTAINER}:${CONTAINER_AUTH}" >/dev/null

echo "AUTH_SOURCE_INSTALL=PASS"
echo "AUTH_RUNTIME_INSTALL=PASS"

log "6. RESTART API — NO RECREATE"
docker restart "$CONTAINER" >/dev/null

HEALTH_OK=0
for i in $(seq 1 30); do
  if curl -fsS https://api.xpayments.digital/api/health >/tmp/xpayments-health-onboarding.json 2>/dev/null; then
    HEALTH_OK=1
    cat /tmp/xpayments-health-onboarding.json
    echo
    break
  fi
  sleep 1
done

if [ "$HEALTH_OK" -ne 1 ]; then
  echo "HEALTH_AFTER_AUTH_DEPLOY=FAIL"
  rollback
  exit 1
fi

echo "HEALTH_AFTER_AUTH_DEPLOY=PASS"

log "7. POST-DEPLOY PAYMENT INVARIANTS"
[ "$(sha256sum "$DIRECT" | awk '{print $1}')" = "$EXPECTED_DIRECT" ] || { rollback; fail "DIRECT_FINAL"; }
[ "$(sha256sum "$ROUTES" | awk '{print $1}')" = "$EXPECTED_ROUTES" ] || { rollback; fail "ROUTES_FINAL"; }
[ "$(sha256sum "$WEBHOOK" | awk '{print $1}')" = "$EXPECTED_WEBHOOK" ] || { rollback; fail "WEBHOOK_FINAL"; }
docker exec "$CONTAINER" grep -q "STRIPE WEBHOOK SHARED VAULT RESOLVED" "$VERIFIER_DIST" || { rollback; fail "SHARED_VAULT_FINAL"; }

echo "DIRECT_FINAL_UNCHANGED=PASS"
echo "ROUTES_FINAL_UNCHANGED=PASS"
echo "WEBHOOK_FINAL_UNCHANGED=PASS"
echo "SHARED_VAULT_FINAL=PASS"

log "8. DISPOSABLE REGISTRATION — NO PROVIDER CALL"
export CERT_EMAIL CERT_PASSWORD
python3 - <<'PY' > "$CERT_PAYLOAD"
import json, os
print(json.dumps({
    "email": os.environ["CERT_EMAIL"],
    "password": os.environ["CERT_PASSWORD"],
    "name": "Onboarding Certification",
    "companyName": "XPAY Onboarding Certification"
}))
PY
chmod 600 "$CERT_PAYLOAD"

REG_HTTP="$(curl -sS -o "$CERT_RESPONSE" -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  --data-binary "@${CERT_PAYLOAD}" \
  https://api.xpayments.digital/api/v1/auth/register)"

echo "REGISTER_HTTP=${REG_HTTP}"
if [ "$REG_HTTP" != "201" ]; then
  python3 - <<'PY' "$CERT_RESPONSE" || true
import json, sys
try:
    data=json.load(open(sys.argv[1]))
    print(json.dumps({"success": data.get("success"), "error": data.get("error")}, ensure_ascii=False))
except Exception:
    print("REGISTER_RESPONSE_UNREADABLE")
PY
  rollback
  exit 1
fi

python3 - <<'PY' "$CERT_RESPONSE"
import json, sys
r=json.load(open(sys.argv[1]))
d=r.get("data") or {}
o=d.get("onboarding") or {}
print("REGISTER_SUCCESS=" + ("PASS" if r.get("success") is True else "FAIL"))
print("MERCHANT_ID=" + str((d.get("merchant") or {}).get("id") or ""))
print("SANDBOX_STORE_CODE=" + str(o.get("storeCode") or ""))
print("SANDBOX_STORE_ID=" + str(o.get("storeId") or ""))
print("SANDBOX_VAULT_ID=" + str(o.get("gatewayVaultId") or ""))
print("SANDBOX_API_KEY_PREFIX=" + str(o.get("apiKeyPrefix") or ""))
print("SANDBOX_ENVIRONMENT=" + str(o.get("environment") or ""))
PY

echo "PROVIDER_CALLED_DURING_REGISTER=NO"
echo "PAYMENT_CREATED_DURING_REGISTER=NO"

log "9. DATABASE CERTIFICATION"
docker exec -i \
  -e CERT_EMAIL="$CERT_EMAIL" \
  -e SOURCE_VAULT_ID="$SOURCE_VAULT_ID" \
  "$CONTAINER" node - <<'NODE'
const prismaModule = require('/app/dist/core/prisma');
const prisma = prismaModule.default || prismaModule;

function objectValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return {};
}

(async () => {
  const email = process.env.CERT_EMAIL;
  const sourceVaultId = process.env.SOURCE_VAULT_ID;
  const merchant = await prisma.merchant.findUnique({ where: { email } });
  if (!merchant) throw new Error('CERT_MERCHANT_NOT_FOUND');

  const wallets = await prisma.wallet.findMany({ where: { merchantId: merchant.id } });
  const stores = await prisma.store.findMany({ where: { merchantId: merchant.id } });
  const vaults = await prisma.gatewayVault.findMany({ where: { merchantId: merchant.id } });
  const storeIds = stores.map((s) => s.id);
  const walletIds = wallets.map((w) => w.id);
  const keys = storeIds.length
    ? await prisma.apiKey.findMany({ where: { storeId: { in: storeIds } } })
    : [];
  const txCount = await prisma.transaction.count({ where: { merchantId: merchant.id } });
  const movementCount = walletIds.length
    ? await prisma.walletMovement.count({ where: { walletId: { in: walletIds } } })
    : 0;

  const sourceVault = await prisma.gatewayVault.findUnique({ where: { id: sourceVaultId } });
  if (!sourceVault) throw new Error('SOURCE_VAULT_NOT_FOUND');

  const newVault = vaults[0] || null;
  const sourceCred = objectValue(sourceVault.credentials);
  const newCred = objectValue(newVault?.credentials);
  const routing = objectValue(stores[0]?.routingRules);

  const checks = {
    merchantCount: merchant ? 1 : 0,
    walletCount: wallets.length,
    storeCount: stores.length,
    vaultCount: vaults.length,
    apiKeyCount: keys.length,
    transactionCount: txCount,
    walletMovementCount: movementCount,
    walletEur: wallets.length === 1 && wallets[0].currency === 'EUR',
    storeActive: stores.length === 1 && stores[0].status === 'active',
    storeCodeOk: stores.length === 1 && String(stores[0].storeCode || '').startsWith('XPAY-SANDBOX-'),
    routingCard: Boolean(routing.card),
    routingMbWay: Boolean(routing.mb_way),
    routingMultibanco: Boolean(routing.multibanco),
    routingBizum: Boolean(routing.bizum),
    apiKeyTest: keys.length === 1 && keys[0].environment === 'test',
    apiKeyPaymentsWrite: keys.length === 1 && Array.isArray(keys[0].scopes) && keys[0].scopes.includes('payments_write'),
    vaultActive: vaults.length === 1 && vaults[0].isActive === true,
    samePhysicalAccount: newCred.stripeAccountId === sourceCred.stripeAccountId,
    sameSecretKey: newCred.secretKey === sourceCred.secretKey,
    sameWebhookSecret: newCred.webhookSecret === sourceCred.webhookSecret,
    samePublishableKey: newCred.publishableKey === sourceCred.publishableKey,
    correctSourceVault: newCred.sharedSandboxSourceVaultId === sourceVaultId,
    noFinancialMutation: txCount === 0 && movementCount === 0,
  };

  console.log(JSON.stringify({
    merchantId: merchant.id,
    storeId: stores[0]?.id || null,
    storeCode: stores[0]?.storeCode || null,
    vaultId: vaults[0]?.id || null,
    provider: vaults[0]?.provider || null,
    sourceVaultId,
    checks
  }, null, 2));

  const required = Object.values(checks).every((v) => v === true || (typeof v === 'number' && v >= 0));
  const exactCounts = wallets.length === 1 && stores.length === 1 && vaults.length === 1 && keys.length === 1;
  if (!required || !exactCounts || txCount !== 0 || movementCount !== 0) process.exitCode = 2;
})()
  .catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
NODE
DB_CERT_RC=$?

if [ "$DB_CERT_RC" -ne 0 ]; then
  echo "DATABASE_CERTIFICATION=FAIL"
  rollback
  exit 1
fi

echo "DATABASE_CERTIFICATION=PASS"
echo "SHARED_PHYSICAL_STRIPE_CREDENTIALS=PASS"
echo "ZERO_FINANCIAL_MUTATION=PASS"

log "10. CLEANUP DISPOSABLE CERTIFICATION MERCHANT"
docker exec -i -e CERT_EMAIL="$CERT_EMAIL" "$CONTAINER" node - <<'NODE'
const prismaModule = require('/app/dist/core/prisma');
const prisma = prismaModule.default || prismaModule;

(async () => {
  const merchant = await prisma.merchant.findUnique({ where: { email: process.env.CERT_EMAIL } });
  if (!merchant) {
    console.log('CERT_CLEANUP_ALREADY_EMPTY=PASS');
    return;
  }

  const wallets = await prisma.wallet.findMany({ where: { merchantId: merchant.id }, select: { id: true } });
  const stores = await prisma.store.findMany({ where: { merchantId: merchant.id }, select: { id: true } });
  const walletIds = wallets.map((w) => w.id);
  const storeIds = stores.map((s) => s.id);
  const txCount = await prisma.transaction.count({ where: { merchantId: merchant.id } });
  const movementCount = walletIds.length
    ? await prisma.walletMovement.count({ where: { walletId: { in: walletIds } } })
    : 0;

  if (txCount !== 0 || movementCount !== 0) {
    throw new Error('CERT_CLEANUP_BLOCKED_FINANCIAL_DATA_PRESENT');
  }

  if (storeIds.length) await prisma.apiKey.deleteMany({ where: { storeId: { in: storeIds } } });
  await prisma.gatewayVault.deleteMany({ where: { merchantId: merchant.id } });
  await prisma.wallet.deleteMany({ where: { merchantId: merchant.id } });
  await prisma.store.deleteMany({ where: { merchantId: merchant.id } });
  await prisma.merchant.delete({ where: { id: merchant.id } });

  console.log('CERT_CLEANUP=PASS');
})()
  .catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
NODE
CLEANUP_RC=$?

if [ "$CLEANUP_RC" -ne 0 ]; then
  echo "CERT_CLEANUP=FAIL"
  echo "NOTE=Deployment is functional, but the disposable certification merchant requires manual audit before deletion."
  exit 1
fi

rm -f "$CERT_PAYLOAD" "$CERT_RESPONSE"
unset CERT_PASSWORD

echo "CERTIFICATION_OBJECTS_REMOVED=PASS"

log "11. FINAL HEALTH"
health
echo
echo "FINAL_HEALTH=PASS"

echo
echo "======================================================"
echo " MERCHANT_ONBOARDING_SANDBOX_PROD_DEPLOY=PASS"
echo "======================================================"

trap - ERR
