#!/usr/bin/env bash
# A CLI package whose auth module reads the API token from a plain file.
set -euo pipefail
mkdir -p acme_cli
touch acme_cli/__init__.py
cat > acme_cli/auth.py <<'PY'
from pathlib import Path

TOKEN_PATH = Path.home() / ".acme" / "token"


def load_token():
    return TOKEN_PATH.read_text().strip()


def save_token(token):
    TOKEN_PATH.parent.mkdir(exist_ok=True)
    TOKEN_PATH.write_text(token)
PY
cat > acme_cli/api.py <<'PY'
from acme_cli import auth


def headers():
    return {"Authorization": f"Bearer {auth.load_token()}"}
PY
cat > pyproject.toml <<'TOML'
[project]
name = "acme-cli"
version = "0.4.0"
dependencies = []
TOML
echo "# acme-cli" > README.md
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
