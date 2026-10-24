#!/usr/bin/env bash
# A jobs repo with 30 commits over two weeks of churn; one of them, six days ago, turns the export's customer lookup into a query per order.
set -euo pipefail
G='git -c user.name=eval -c user.email=eval@example.com'
# Commit n is (29 - n) * 12 hours old, so the history spans two weeks and commit 17 lands six days ago.
at() { local d; d="$(( $(date +%s) - (29 - $1) * 43200 )) +0000"; GIT_AUTHOR_DATE=$d GIT_COMMITTER_DATE=$d "${@:2}"; }
mkdir -p jobs fixtures docs
cat > jobs/store.py <<'PY'
def orders(day):
    raise NotImplementedError


def customers():
    raise NotImplementedError


def customer(cid):
    """One query per call."""
    raise NotImplementedError
PY
cat > jobs/export.py <<'PY'
from jobs.store import orders, customers


def export(day):
    rows = []
    by_id = {c["id"]: c for c in customers()}
    for o in orders(day):
        rows.append({**o, "customer": by_id[o["customer_id"]]["name"]})
    return rows


def fmt(row):
    return ",".join(str(v) for v in row.values())
PY
printf '# jobs\n\nNightly export of the day orders with customer names, plus reporting jobs.\n' > README.md
fixtures() { for i in $(seq 1 400); do printf '{"id": %d, "customer_id": %d, "total": %d, "batch": "%s"}\n' "$i" $(( (i * 7 + $1) % 997 )) $(( (i * 13 + $1) % 5000 )) "$1"; done > fixtures/orders.jsonl; }
fixtures 0
git init -q && git add -A && at -1 $G commit -qm "export: nightly orders export"
for n in $(seq 1 29); do
  fixtures "$n"
  case $n in
    5) printf '\n\ndef by_region(rows):\n    out = {}\n    for r in rows:\n        out.setdefault(r.get("region"), []).append(r)\n    return out\n' > jobs/report.py; msg="report: group rows by region" ;;
    11) printf '\n\ndef header(rows):\n    return ",".join(rows[0].keys()) if rows else ""\n' >> jobs/export.py; msg="export: csv header helper" ;;
    17) python3 - <<'PY'
import re
p = "jobs/export.py"
s = open(p).read()
s = s.replace("from jobs.store import orders, customers\n", "from jobs.store import orders, customer\n")
s = s.replace('    by_id = {c["id"]: c for c in customers()}\n', "")
s = s.replace('"customer": by_id[o["customer_id"]]["name"]', '"customer": customer(o["customer_id"])["name"]')
open(p, "w").write(s)
PY
        msg="export: simplify customer lookup" ;;
    22) printf '\n\ndef totals(rows):\n    return sum(r.get("total", 0) for r in rows)\n' >> jobs/report.py; msg="report: daily totals" ;;
    *) printf 'Run %d notes: fixtures refreshed.\n' "$n" > docs/run-notes.md; msg="fixtures: refresh sample orders ($n)" ;;
  esac
  git add -A && at "$n" $G commit -qm "$msg"
done
