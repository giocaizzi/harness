#!/usr/bin/env bash
# A repo with an audit workflow that only triggers on push.
set -euo pipefail
mkdir -p .github/workflows
cat > .github/workflows/audit.yml <<'YML'
name: Audit
on:
  push:
    branches: [main]

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm audit --audit-level=high
YML
cat > package.json <<'JSON'
{ "name": "app", "version": "1.0.0", "dependencies": { "express": "^4.19.0" } }
JSON
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
