#!/usr/bin/env bash
# A Node app with a Buildkite pipeline that installs dependencies on each build.
set -euo pipefail
mkdir -p .buildkite
cat > .buildkite/pipeline.yml <<'YML'
steps:
  - label: ":npm: install and test"
    command:
      - npm install
      - npm test
    plugins:
      - docker#v5.11.0:
          image: "node:22"
  - label: ":package: build"
    command:
      - npm install
      - npm run build
    plugins:
      - docker#v5.11.0:
          image: "node:22"
YML
cat > package.json <<'JSON'
{
  "name": "app",
  "version": "1.0.0",
  "scripts": { "test": "node --test", "build": "node build.js" },
  "dependencies": { "express": "^4.19.0", "zod": "^3.23.0" }
}
JSON
cat > package-lock.json <<'JSON'
{ "name": "app", "version": "1.0.0", "lockfileVersion": 3, "requires": true, "packages": { "": { "name": "app", "version": "1.0.0", "dependencies": { "express": "^4.19.0", "zod": "^3.23.0" } } } }
JSON
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
