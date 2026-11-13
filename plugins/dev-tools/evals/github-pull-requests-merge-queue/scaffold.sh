#!/usr/bin/env bash
# A tiny repo with a CI workflow that runs on pull requests only.
set -euo pipefail
mkdir -p .github/workflows
cat > .github/workflows/ci.yml <<'YAML'
name: ci
on: pull_request
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - run: make check
YAML
printf 'check:\n\t@echo ok\n' > Makefile
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
