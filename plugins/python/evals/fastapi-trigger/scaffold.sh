#!/usr/bin/env bash
# A minimal FastAPI app with pydantic v2.
set -euo pipefail
printf '[project]\nname = "acme-app"\nversion = "0.1.0"\ndependencies = ["fastapi", "pydantic>=2"]\n' > pyproject.toml
printf 'from fastapi import FastAPI\n\napp = FastAPI()\n\n\n@app.get("/health")\ndef health():\n    return {"ok": True}\n' > main.py
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
