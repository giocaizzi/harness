#!/usr/bin/env bash
# Four services with the same config shape.
set -euo pipefail
for s in api billing mailer search; do
  mkdir -p services/$s
  printf 'name: %s\ntimeout: 30\n' "$s" > services/$s/config.yaml
  cat > services/$s/main.py <<'PY'
def connect(timeout, retries=1):
    return {"timeout": timeout, "retries": retries}


def start(cfg):
    return connect(cfg["timeout"])
PY
  cat > services/$s/test_main.py <<'PY'
from main import start


def test_start():
    assert start({"timeout": 30})["timeout"] == 30
PY
done
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
