#!/usr/bin/env bash
# A FastAPI app with no database.
set -euo pipefail
printf '[project]\nname = "acme-app"\nversion = "0.1.0"\ndependencies = ["fastapi"]\n' > pyproject.toml
printf 'from fastapi import FastAPI\n\napp = FastAPI()\n' > main.py
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
