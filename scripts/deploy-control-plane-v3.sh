#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="/root/xpayments-backend-v3"
BRANCH="fix/checkout-signed-reconcile-20260907"
BASE="/root/deploy-control-plane-v1-v3-fixed.sh"

cd "$ROOT"
git fetch origin "$BRANCH" >/dev/null 2>&1

TARGET_COMMIT="$(git rev-parse "origin/$BRANCH")"
echo "CONTROL_PLANE_V3_TARGET_COMMIT=$TARGET_COMMIT"

git show "origin/$BRANCH:scripts/deploy-control-plane-v1.sh" >"$BASE"

# Patch stdin requirement for the DB read gate.
COUNT_STDIN="$(grep -F -c 'docker exec "$CONTAINER" node - <<' "$BASE" || true)"
[ "$COUNT_STDIN" = "1" ] || {
  echo "CONTROL_PLANE_STDIN_PATCH=FAIL"
  echo "EXPECTED_OCCURRENCES=1 ACTUAL_OCCURRENCES=$COUNT_STDIN"
  exit 1
}
sed -i 's/docker exec "$CONTAINER" node - <<'"'"'NODE'"'"'/docker exec -i "$CONTAINER" node - <<'"'"'NODE'"'"'/' "$BASE"
grep -F -q 'docker exec -i "$CONTAINER" node - <<' "$BASE" || {
  echo "CONTROL_PLANE_STDIN_PATCH=FAIL"
  exit 1
}
echo "CONTROL_PLANE_STDIN_PATCH=PASS"

# Replace the brittle legacy-only gateway pre-state gate with a fail-closed
# classifier that accepts either the legacy source or an already-hardened source.
python3 - "$BASE" <<'PY'
from pathlib import Path
import sys

p = Path(sys.argv[1])
s = p.read_text()
old = '''echo "=== 2. GATEWAY PRE-STATE ==="
grep -q "data: req.body" src/modules/gateway/controllers/gateway.controller.ts || fail "GATEWAY_PRE_EXPECTED_STATE"
echo "GATEWAY_PRE_EXPECTED_STATE=PASS"
'''
new = '''echo "=== 2. GATEWAY PRE-STATE ==="
GATEWAY_SRC="src/modules/gateway/controllers/gateway.controller.ts"
if grep -q "data: req.body" "$GATEWAY_SRC"; then
  echo "GATEWAY_PRE_STATE=LEGACY"
  echo "GATEWAY_PRE_EXPECTED_STATE=PASS"
elif grep -q "findOwnedStore" "$GATEWAY_SRC" && ! grep -q "data: req.body" "$GATEWAY_SRC"; then
  echo "GATEWAY_PRE_STATE=ALREADY_HARDENED"
  echo "GATEWAY_PRE_EXPECTED_STATE=PASS"
else
  echo "GATEWAY_PRE_STATE=UNKNOWN"
  fail "GATEWAY_PRE_EXPECTED_STATE"
fi
'''
if old not in s:
    print('CONTROL_PLANE_GATEWAY_PRESTATE_PATCH=FAIL')
    raise SystemExit(1)
p.write_text(s.replace(old, new, 1))
print('CONTROL_PLANE_GATEWAY_PRESTATE_PATCH=PASS')
PY

chmod 700 "$BASE"
exec bash "$BASE"
