#!/usr/bin/env bash
# A python package at 1.3.1 managed by release-please, with a feat commit that makes it propose 1.4.0.
set -euo pipefail
mkdir -p acme_tool .github/workflows
echo '__version__ = "1.3.1"' > acme_tool/__init__.py
cat > pyproject.toml <<'TOML'
[project]
name = "acme-tool"
version = "1.3.1"
TOML
cat > release-please-config.json <<'JSON'
{
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "packages": {
    ".": {
      "release-type": "python",
      "package-name": "acme-tool"
    }
  }
}
JSON
echo '{ ".": "1.3.1" }' > .release-please-manifest.json
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
printf '# Changelog\n\n## 1.3.1\n\n* fix: handle empty input\n' > CHANGELOG.md
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm "chore: release 1.3.1"
echo "# tweak" >> acme_tool/__init__.py
git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm "fix: handle empty input in parser"
echo "# flag" >> acme_tool/__init__.py
git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm "feat: add --quiet flag"
