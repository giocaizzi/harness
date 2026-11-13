#!/usr/bin/env bash
# A small Flask API whose three handlers return errors in different shapes.
set -euo pipefail
mkdir -p src/shop
cat > pyproject.toml <<'T'
[project]
name = "shop"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = ["flask"]
T
cat > src/shop/api.py <<'T'
from flask import Flask, jsonify, request

app = Flask(__name__)
ORDERS = {"1": {"id": "1", "qty": 2}}


@app.get("/orders/<order_id>")
def get_order(order_id: str):
    order = ORDERS.get(order_id)
    if order is None:
        return jsonify({"error": "order not found"}), 404
    return jsonify(order)


@app.post("/orders")
def create_order():
    body = request.get_json(silent=True) or {}
    if "qty" not in body:
        return jsonify({"message": "qty is required", "code": 400}), 400
    return jsonify({"id": "2", "qty": body["qty"]}), 201


@app.delete("/orders/<order_id>")
def delete_order(order_id: str):
    if order_id not in ORDERS:
        return jsonify({"errors": [{"detail": "no such order"}]}), 404
    del ORDERS[order_id]
    return "", 204
T
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
