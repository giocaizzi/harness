#!/usr/bin/env bash
# A tiny FastAPI service whose POST /payments charges on every call.
set -euo pipefail
mkdir -p src/payments
cat > pyproject.toml <<'TOML'
[project]
name = "payments"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = ["fastapi"]
TOML
cat > src/payments/app.py <<'PY'
import uuid

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()
PAYMENTS: dict[str, dict] = {}


class PaymentIn(BaseModel):
    customer_id: str
    amount_minor: int
    currency: str


@app.post("/payments", status_code=201)
def create_payment(body: PaymentIn) -> dict:
    payment_id = str(uuid.uuid4())
    PAYMENTS[payment_id] = {"id": payment_id, **body.model_dump()}
    # charge the card here
    return PAYMENTS[payment_id]
PY
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
