#!/usr/bin/env bash
# A repo whose CI workflow runs only on pull_request.
set -euo pipefail
mkdir -p .github/workflows src
printf 'export const version = "1.0.0";\n' > src/index.ts
cat > package.json <<'JSON'
{ "name": "app", "scripts": { "test": "vitest run" } }
JSON
cat > .github/workflows/ci.yml <<'YML'
name: CI
on:
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npm test
YML
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
