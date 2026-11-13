#!/usr/bin/env bash
# A repo with a compose file for postgres and a dev make target for the API.
set -euo pipefail
cat > docker-compose.yml <<'YML'
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: dev
    ports:
      - "5432:5432"
YML
cat > Makefile <<'MK'
.PHONY: dev

dev:
	docker compose up -d db
	python -m uvicorn app.main:app --reload --port 8000
MK
mkdir -p app
touch app/__init__.py
cat > app/main.py <<'PY'
from fastapi import FastAPI

app = FastAPI()


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
PY
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
