#!/usr/bin/env bash
# A repo with release-please configured and main commits whose messages are not conventional.
set -euo pipefail
mkdir -p app .github/workflows
echo '__version__ = "0.9.0"' > app/__init__.py
cat > release-please-config.json <<'JSON'
{
  "packages": {
    ".": {
      "release-type": "python",
      "package-name": "acme-app"
    }
  }
}
JSON
echo '{ ".": "0.9.0" }' > .release-please-manifest.json
cat > .github/workflows/release-please.yml <<'YML'
name: release-please
on:
  push:
    branches: [main]
jobs:
  release-please:
    runs-on: ubuntu-latest
    steps:
      - uses: googleapis/release-please-action@v4
YML
echo "# app" > README.md
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm "chore: release 0.9.0"
echo "# a" >> app/__init__.py
git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm "Fix login redirect"
echo "# b" >> app/__init__.py
git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm "Fixed crash on empty form"
echo "# c" >> app/__init__.py
git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm "Fix typo in error page"
