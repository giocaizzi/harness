#!/usr/bin/env bash
# A monorepo with api/ and web/ directories and one CI workflow with a job for each.
set -euo pipefail
mkdir -p api web .github/workflows
printf 'def health():\n    return "ok"\n' > api/app.py
printf 'def test_health():\n    assert True\n' > api/test_app.py
printf 'console.log("web");\n' > web/index.js
cat > web/package.json <<'JSON'
{ "name": "web", "scripts": { "test": "node --test" } }
JSON
cat > .github/workflows/ci.yml <<'YML'
name: CI
on:
  pull_request:

jobs:
  api-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.13"
      - run: pip install pytest
      - run: pytest api
  web-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm test
        working-directory: web
YML
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
