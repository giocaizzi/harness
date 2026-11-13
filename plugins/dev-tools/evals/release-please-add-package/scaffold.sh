#!/usr/bin/env bash
# A python monorepo where release-please already releases packages/core, with a new packages/cli not yet configured.
set -euo pipefail
mkdir -p packages/core/acme_core packages/cli/acme_cli .github/workflows
echo '__version__ = "0.5.0"' > packages/core/acme_core/__init__.py
cat > packages/core/pyproject.toml <<'TOML'
[project]
name = "acme-core"
version = "0.5.0"
TOML
echo '__version__ = "0.1.0"' > packages/cli/acme_cli/__init__.py
cat > packages/cli/pyproject.toml <<'TOML'
[project]
name = "acme-cli"
version = "0.1.0"
dependencies = ["acme-core"]
TOML
cat > release-please-config.json <<'JSON'
{
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "packages": {
    "packages/core": {
      "release-type": "python",
      "package-name": "acme-core"
    }
  }
}
JSON
echo '{ "packages/core": "0.5.0" }' > .release-please-manifest.json
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
echo "# acme monorepo" > README.md
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
