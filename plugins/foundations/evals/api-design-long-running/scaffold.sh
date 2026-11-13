#!/usr/bin/env bash
# A report API whose POST handler builds the report synchronously.
set -euo pipefail
mkdir -p src/reports
cat > src/reports/api.py <<'T'
import time

from flask import Flask, jsonify, request

app = Flask(__name__)


def build_report(kind: str) -> dict:
    time.sleep(120)  # stands in for the heavy aggregation
    return {"kind": kind, "rows": 125000, "url": f"/files/{kind}.csv"}


@app.post("/reports")
def create_report():
    kind = (request.get_json(silent=True) or {}).get("kind", "sales")
    return jsonify(build_report(kind)), 200
T
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
