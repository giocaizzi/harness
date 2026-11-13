#!/usr/bin/env bash
# A small web app with a reports module.
set -euo pipefail
mkdir -p app/reports templates
cat > app/reports/views.py <<'P'
from app.reports.queries import monthly_totals


def reports_page():
    rows = monthly_totals()
    return {"template": "reports.html", "rows": rows}
P
cat > app/reports/queries.py <<'P'
def monthly_totals():
    return [{"month": "2026-01", "total": 120}, {"month": "2026-02", "total": 98}]
P
cat > templates/reports.html <<'P'
<h1>Reports</h1>
<table>{% for r in rows %}<tr><td>{{ r.month }}</td><td>{{ r.total }}</td></tr>{% endfor %}</table>
P
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
