#!/usr/bin/env bash
# A nightly export job whose history holds a regression.
set -euo pipefail
mkdir -p jobs
G='git -c user.name=eval -c user.email=eval@example.com'
cat > jobs/export.py <<'PY'
from jobs.store import orders, customers


def export(day):
    rows = []
    by_id = {c["id"]: c for c in customers()}
    for o in orders(day):
        rows.append({**o, "customer": by_id[o["customer_id"]]["name"]})
    return rows
PY
cat > jobs/store.py <<'PY'
def orders(day):
    raise NotImplementedError


def customers():
    raise NotImplementedError


def customer(cid):
    raise NotImplementedError
PY
git init -q && git add -A && $G commit -qm "export: nightly orders export"
printf '\n\ndef fmt(row):\n    return ",".join(str(v) for v in row.values())\n' >> jobs/export.py
git add -A && $G commit -qm "export: csv formatting helper"
cat > jobs/export.py <<'PY'
from jobs.store import orders, customer


def export(day):
    rows = []
    for o in orders(day):
        rows.append({**o, "customer": customer(o["customer_id"])["name"]})
    return rows


def fmt(row):
    return ",".join(str(v) for v in row.values())
PY
git add -A && $G commit -qm "export: simplify customer lookup"
printf '# jobs\n\nNightly export of the day orders with customer names.\n' > README.md
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
