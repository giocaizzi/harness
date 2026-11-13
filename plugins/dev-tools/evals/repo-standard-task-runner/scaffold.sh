#!/usr/bin/env bash
# A python repo whose CONTRIBUTING.md lists ad-hoc commands and which has no Makefile.
set -euo pipefail
mkdir -p acme_etl tests
echo 'def run():
    return "ok"' > acme_etl/__init__.py
echo 'from acme_etl import run


def test_run():
    assert run() == "ok"' > tests/test_run.py
cat > pyproject.toml <<'TOML'
[project]
name = "acme-etl"
version = "0.2.0"

[tool.ruff]
line-length = 100
TOML
cat > CONTRIBUTING.md <<'MD'
# Contributing

Some of us run `ruff check .`, others `flake8 acme_etl`. For tests try `pytest -q`,
`python -m pytest tests/` or `uv run pytest`. Format with `black .` before you push.
MD
echo "# acme-etl" > README.md
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
