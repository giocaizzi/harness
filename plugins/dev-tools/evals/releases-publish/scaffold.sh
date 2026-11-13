#!/usr/bin/env bash
# A small Python library with no release or publish setup yet.
set -euo pipefail
printf '[project]\nname = "tinylib"\nversion = "0.1.0"\nrequires-python = ">=3.14"\n\n[build-system]\nrequires = ["hatchling"]\nbuild-backend = "hatchling.build"\n' > pyproject.toml
mkdir -p src/tinylib && printf 'def hello():\n    return "hi"\n' > src/tinylib/__init__.py
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
