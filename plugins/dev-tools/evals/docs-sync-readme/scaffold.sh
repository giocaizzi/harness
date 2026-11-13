#!/usr/bin/env bash
# A Python project with a pip-based README and a pyproject.toml plus uv.lock.
set -euo pipefail
mkdir -p src/tool
printf 'def main() -> None:\n    print("tool")\n' > src/tool/__init__.py
cat > pyproject.toml <<'TOML'
[project]
name = "tool"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = ["requests"]

[project.scripts]
tool = "tool:main"
TOML
cat > uv.lock <<'LOCK'
version = 1
requires-python = ">=3.12"

[[package]]
name = "tool"
version = "0.1.0"
source = { editable = "." }
LOCK
cat > README.md <<'MD'
# tool

A small command-line tool.

## Install

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pip install -e .
```

## Run

```bash
tool
```
MD
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
