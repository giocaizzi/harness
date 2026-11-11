#!/usr/bin/env bash
# A tiny repo with a workflow file; the prompt asks a YAML syntax question, not about PRs or branches.
set -euo pipefail
mkdir -p .github/workflows
cat > .github/workflows/ci.yml <<'YML'
name: ci
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
YML
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
