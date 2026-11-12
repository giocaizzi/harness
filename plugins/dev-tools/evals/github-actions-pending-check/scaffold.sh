#!/usr/bin/env bash
# A required workflow with a trigger-level paths-ignore filter.
set -euo pipefail
mkdir -p .github/workflows docs
cat > .github/workflows/ci.yml <<'YML'
name: ci
on:
  pull_request:
    paths-ignore: ['docs/**', '**.md']
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: make check
YML
printf 'check:\n\ttrue\n' > Makefile
printf '# Docs\n' > docs/index.md
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
