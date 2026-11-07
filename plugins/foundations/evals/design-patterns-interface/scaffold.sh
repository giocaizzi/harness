#!/usr/bin/env bash
# A checkout service that calls one payment provider directly.
set -euo pipefail
mkdir -p src/checkout
cat > pyproject.toml <<'TOML'
[project]
name = "checkout"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = ["httpx"]
TOML
cat > src/checkout/provider.py <<'PY'
import httpx


class PaymentProvider:
    def __init__(self, api_key: str) -> None:
        self._http = httpx.Client(base_url="https://pay.acme.example", headers={"Authorization": api_key})

    def charge(self, customer_id: str, amount_minor: int, currency: str) -> str:
        resp = self._http.post("/charges", json={"customer": customer_id, "amount": amount_minor, "currency": currency})
        resp.raise_for_status()
        return resp.json()["id"]
PY
cat > src/checkout/service.py <<'PY'
from checkout.provider import PaymentProvider


class CheckoutService:
    def __init__(self, provider: PaymentProvider) -> None:
        self._provider = provider

    def pay(self, customer_id: str, amount_minor: int, currency: str) -> str:
        return self._provider.charge(customer_id, amount_minor, currency)
PY
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
