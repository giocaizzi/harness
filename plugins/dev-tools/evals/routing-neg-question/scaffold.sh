#!/usr/bin/env bash
# One small helper module.
set -euo pipefail
cat > text.py <<'PY'
import re


def slugify(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
PY
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
