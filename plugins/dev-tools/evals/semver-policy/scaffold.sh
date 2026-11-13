#!/usr/bin/env bash
# A small TypeScript library at 1.4.0 with a public index.ts.
set -euo pipefail
mkdir -p src
cat > package.json <<'T'
{
  "name": "@acme/slugify",
  "version": "1.4.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts"
}
T
cat > src/index.ts <<'T'
export function slugify(input: string, separator = "-"): string {
  return input.toLowerCase().trim().replace(/\s+/g, separator);
}
T
cat > README.md <<'T'
# @acme/slugify

Turn text into URL slugs.
T
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
