#!/usr/bin/env bash
# A Node repo with one GitHub Actions workflow on a single Node version.
set -euo pipefail
mkdir -p .github/workflows
cat > .github/workflows/ci.yml <<'YML'
name: ci
on:
  pull_request:
  push:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci && npm test
YML
printf '{"name":"app","scripts":{"test":"node --test"}}\n' > package.json
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
