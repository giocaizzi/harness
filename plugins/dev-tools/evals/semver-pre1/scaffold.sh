#!/usr/bin/env bash
# A tiny Python library at version 0.9.2 with a parse() function.
set -euo pipefail
mkdir -p src/acme_parse
cat > pyproject.toml <<'T'
[project]
name = "acme-parse"
version = "0.9.2"
T
cat > src/acme_parse/__init__.py <<'P'
def parse(text):
    return text.split(",")
P
cat > CHANGELOG.md <<'T'
# Changelog

## 0.9.2
- Fix trailing comma handling.
T
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
