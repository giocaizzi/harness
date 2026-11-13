#!/usr/bin/env bash
# An order API with an OpenAPI document and a handler that returns qty.
set -euo pipefail
mkdir -p src/shop
cat > openapi.yaml <<'T'
openapi: 3.0.3
info:
  title: Shop API
  version: 1.4.0
paths:
  /orders/{id}:
    get:
      parameters:
        - name: id
          in: path
          required: true
          schema: {type: string}
      responses:
        "200":
          description: The order
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Order"
components:
  schemas:
    Order:
      type: object
      required: [id, qty]
      properties:
        id: {type: string}
        qty: {type: integer}
T
cat > src/shop/api.py <<'T'
from flask import Flask, jsonify

app = Flask(__name__)
ORDERS = {"1": {"id": "1", "qty": 2}}


@app.get("/orders/<order_id>")
def get_order(order_id: str):
    return jsonify(ORDERS[order_id])
T
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
