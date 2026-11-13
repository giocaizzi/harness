#!/usr/bin/env bash
# A workflow that runs tests and posts a coverage comment on the PR, with no permissions block.
set -euo pipefail
mkdir -p .github/workflows
cat > .github/workflows/coverage.yml <<'YML'
name: Coverage
on:
  pull_request:

jobs:
  coverage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npm test -- --coverage --coverageReporters=text-summary | tee coverage.txt
      - name: Comment coverage on the PR
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const body = fs.readFileSync('coverage.txt', 'utf8');
            await github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              body,
            });
YML
cat > package.json <<'JSON'
{ "name": "app", "scripts": { "test": "jest" } }
JSON
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
