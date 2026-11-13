#!/usr/bin/env bash
# A python library published to PyPI at 2.3.1, with a changelog and a publish workflow.
set -euo pipefail
mkdir -p acme_store .github/workflows
cat > acme_store/__init__.py <<'PY'
__version__ = "2.3.1"


def purge(items, keep):
    return [item for item in items if item in keep]
PY
cat > pyproject.toml <<'TOML'
[project]
name = "acme-store"
version = "2.3.1"
TOML
printf '# Changelog\n\n## 2.3.1\n\n- Speed up purge()\n\n## 2.3.0\n\n- Add purge()\n' > CHANGELOG.md
cat > .github/workflows/publish.yml <<'YML'
name: publish
on:
  push:
    tags: ["v*"]
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v5
      - run: uv build && uv publish
YML
echo "# acme-store" > README.md
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm "release 2.3.1"
git tag v2.3.1
