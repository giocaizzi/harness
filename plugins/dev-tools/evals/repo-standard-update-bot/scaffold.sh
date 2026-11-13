#!/usr/bin/env bash
# A Node project on GitHub with a CI workflow and no update bot configured.
set -euo pipefail
mkdir -p .github/workflows src
cat > package.json <<'JSON'
{
  "name": "acme-web",
  "version": "1.0.0",
  "scripts": { "test": "node --test", "lint": "eslint ." },
  "dependencies": { "express": "^4.17.1" },
  "devDependencies": { "eslint": "^7.32.0" }
}
JSON
cat > .github/workflows/ci.yml <<'YML'
name: ci
on:
  pull_request:
  push:
    branches: [main]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: 18
      - run: npm ci
      - run: npm run lint && npm test
YML
echo "console.log('hi');" > src/index.js
echo "# acme-web" > README.md
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
