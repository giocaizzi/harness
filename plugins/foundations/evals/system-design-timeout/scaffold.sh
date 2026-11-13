#!/usr/bin/env bash
# A checkout handler calling a payment provider with no timeout.
set -euo pipefail
mkdir -p src/checkout
cat > pyproject.toml <<'T'
[project]
name = "checkout"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = ["flask", "requests"]
T
cat > src/checkout/payments.py <<'T'
import requests


def charge(customer_id: str, amount_cents: int) -> str:
    resp = requests.post(
        "https://pay.acme.example/charges",
        json={"customer": customer_id, "amount": amount_cents},
    )
    resp.raise_for_status()
    return resp.json()["id"]
T
cat > src/checkout/app.py <<'T'
from flask import Flask, jsonify, request

from checkout.payments import charge

app = Flask(__name__)


@app.post("/checkout")
def checkout():
    body = request.get_json()
    charge_id = charge(body["customer_id"], body["amount_cents"])
    return jsonify({"charge_id": charge_id})
T
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
