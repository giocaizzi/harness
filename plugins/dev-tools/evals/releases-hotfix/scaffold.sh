#!/usr/bin/env bash
# A library with v1.4.0 and v2.1.0 tags and no release tool configured.
set -euo pipefail
printf '[project]\nname = "lib"\nversion = "1.4.0"\n' > pyproject.toml
printf 'def parse(s):\n    return s.split(",")\n' > lib.py
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm "feat: parse"
git tag v1.4.0
printf '[project]\nname = "lib"\nversion = "2.1.0"\n' > pyproject.toml
printf 'def parse(s):\n    return [p for p in s.split(",") if p]\n' > lib.py
git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm "fix!: skip empty fields"
git tag v2.1.0
