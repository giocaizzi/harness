#!/usr/bin/env bash
# A small library whose public function changed a parameter name.
set -euo pipefail
printf 'def fetch(url, timeout_s=10):\n    return url, timeout_s\n' > lib.py
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
