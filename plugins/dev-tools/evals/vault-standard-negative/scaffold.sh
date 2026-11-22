#!/usr/bin/env bash
set -euo pipefail
cat > config.py <<'P'
DATABASE_URL = "postgresql://localhost/app"
P
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
