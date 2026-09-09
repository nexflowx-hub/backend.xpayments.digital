#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="/root/xpayments-backend-v3"
BRANCH="fix/checkout-signed-reconcile-20260907"
BASE="/root/deploy-control-plane-v1-fixed.sh"

cd "$ROOT"
git fetch origin "$BRANCH" >/dev/null 2>&1

TARGET_COMMIT="$(git rev-parse "origin/$BRANCH")"
echo "CONTROL_PLANE_V2_TARGET_COMMIT=$TARGET_COMMIT"

git show "origin/$BRANCH:scripts/deploy-control-plane-v1.sh" >"$BASE"

COUNT="$(grep -F -c 'docker exec "$CONTAINER" node - <<' "$BASE" || true)"
[ "$COUNT" = "1" ] || {
  echo "CONTROL_PLANE_STDIN_PATCH=FAIL"
  echo "EXPECTED_OCCURRENCES=1 ACTUAL_OCCURRENCES=$COUNT"
  exit 1
}

sed -i 's/docker exec "$CONTAINER" node - <<'"'"'NODE'"'"'/docker exec -i "$CONTAINER" node - <<'"'"'NODE'"'"'/' "$BASE"

grep -F -q 'docker exec -i "$CONTAINER" node - <<' "$BASE" || {
  echo "CONTROL_PLANE_STDIN_PATCH=FAIL"
  exit 1
}

chmod 700 "$BASE"
echo "CONTROL_PLANE_STDIN_PATCH=PASS"

exec bash "$BASE"
