#!/usr/bin/env bash
set -Eeuo pipefail

PROD_ROOT="/root/xpayments-backend-v3"
BRANCH="fix/checkout-signed-reconcile-20260907"
BASE_SCRIPT="/root/deploy-xpay-expert-runtime-v2-fixed.sh"

cd "$PROD_ROOT"

git fetch origin "$BRANCH" >/dev/null 2>&1

git show \
  "origin/${BRANCH}:scripts/deploy-xpay-expert-runtime-v2.sh" \
  >"$BASE_SCRIPT"

python3 - <<'PY' "$BASE_SCRIPT"
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
old = 'dist/modules/expert/routes/expert.public.routes.js'
new = 'dist/modules/expert/routes/expert-public.routes.js'
count = text.count(old)

if count != 1:
    print(f'PUBLIC_ROUTE_GATE_PATCH_COUNT={count}')
    raise SystemExit(2)

path.write_text(text.replace(old, new))
print('PUBLIC_ROUTE_GATE_PATCH=PASS')
PY

chmod 700 "$BASE_SCRIPT"

exec bash "$BASE_SCRIPT"
