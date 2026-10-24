#!/usr/bin/env bash
# A small HTTP API with API-key auth.
set -euo pipefail
mkdir -p api tests
cat > api/server.py <<'PY'
from api.auth import key_of
from api.routes import ROUTES


def handle(request):
    key = key_of(request)
    if key is None:
        return {"status": 401}
    route = ROUTES.get((request["method"], request["path"]))
    if route is None:
        return {"status": 404}
    return route(request)
PY
cat > api/auth.py <<'PY'
def key_of(request):
    return request.get("headers", {}).get("x-api-key")
PY
cat > api/routes.py <<'PY'
def list_items(request):
    return {"status": 200, "body": []}


def create_item(request):
    return {"status": 201, "body": request.get("body")}


ROUTES = {("GET", "/items"): list_items, ("POST", "/items"): create_item}
PY
cat > api/config.py <<'PY'
SETTINGS = {"port": 8080}
PY
cat > tests/test_server.py <<'PY'
from api.server import handle


def test_needs_key():
    assert handle({"method": "GET", "path": "/items"})["status"] == 401
PY
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
