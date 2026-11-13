#!/usr/bin/env bash
# An API whose handler returns a field missing from openapi.yaml.
set -euo pipefail
mkdir -p src/shop
cat > Makefile <<'T'
.PHONY: test
test:
	python -m pytest
T
cat > openapi.yaml <<'T'
openapi: 3.0.3
info:
  title: Shop API
  version: 1.0.0
paths:
  /products/{id}:
    get:
      parameters:
        - name: id
          in: path
          required: true
          schema: {type: string}
      responses:
        "200":
          description: The product
          content:
            application/json:
              schema:
                type: object
                required: [id, name]
                properties:
                  id: {type: string}
                  name: {type: string}
T
cat > src/shop/api.py <<'T'
from flask import Flask, jsonify

app = Flask(__name__)
PRODUCTS = {"7": {"id": "7", "name": "Desk lamp", "price_cents": 2900, "stock": 14}}


@app.get("/products/<product_id>")
def get_product(product_id: str):
    return jsonify(PRODUCTS[product_id])
T
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
