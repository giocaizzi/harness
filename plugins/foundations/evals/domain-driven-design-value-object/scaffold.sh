#!/usr/bin/env bash
# A billing module passing amount floats and currency strings around.
set -euo pipefail
mkdir -p src/billing
cat > src/billing/invoice.py <<'T'
def add_line(total: float, currency: str, amount: float, line_currency: str) -> tuple[float, str]:
    if currency != line_currency:
        raise ValueError("currency mismatch")
    return total + amount, currency


def apply_tax(amount: float, currency: str, rate: float) -> tuple[float, str]:
    return round(amount * (1 + rate), 2), currency
T
cat > src/billing/report.py <<'T'
from billing.invoice import add_line


def invoice_total(lines: list[tuple[float, str]]) -> tuple[float, str]:
    total, currency = 0.0, lines[0][1]
    for amount, line_currency in lines:
        total, currency = add_line(total, currency, amount, line_currency)
    return total, currency
T
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
