#!/usr/bin/env bash
# A Node/TypeScript repo with a CI workflow that has lint and test jobs.
set -euo pipefail
cat > package.json <<'JSON'
{
  "name": "app",
  "version": "1.0.0",
  "scripts": {
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  }
}
JSON
mkdir -p src
printf 'export const add = (a: number, b: number): number => a + b;\n' > src/index.ts
cat > tsconfig.json <<'JSON'
{ "compilerOptions": { "strict": true, "target": "ES2022", "module": "ESNext", "noEmit": true }, "include": ["src"] }
JSON

mkdir -p .github/workflows
cat > .github/workflows/ci.yml <<'YML'
name: CI
on:
  pull_request:
  push:
    branches: [main]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run lint
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm test
YML
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
