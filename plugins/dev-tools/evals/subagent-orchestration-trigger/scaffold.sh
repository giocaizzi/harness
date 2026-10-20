#!/usr/bin/env bash
# Five independent services that each call a deprecated logger.
set -euo pipefail
for s in auth billing search media notify; do
  mkdir -p services/$s
  printf 'from legacy_log import warn\n\ndef run():\n    warn("%s started")\n' "$s" > services/$s/main.py
done
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
