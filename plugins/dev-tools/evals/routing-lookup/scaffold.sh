#!/usr/bin/env bash
# A web app of 72 modules whose handlers reach the database through chains of helpers; 11 of the 12 handlers do.
set -euo pipefail
mkdir -p app/web app/domain app/infra
printf 'def query(sql, *args):\n    raise NotImplementedError\n' > app/infra/db.py
filler() {
  for f in 1 2 3 4 5 6; do
    printf '\n\ndef helper_%s_%s(x):\n    """Pure formatting helper."""\n    y = [str(v).strip() for v in x]\n    return ",".join(sorted(y))\n' "$1" "$f"
  done
}
# domain/m1..m60: m(i) calls m(i+7) when i+7 <= 60; every 9th module queries the database
for i in $(seq 1 60); do
  {
    if [ $((i % 9)) -eq 0 ]; then printf 'from app.infra import db\n'; fi
    if [ $((i + 7)) -le 60 ]; then printf 'from app.domain import m%s\n' $((i + 7)); fi
    printf '\n\ndef step(x):\n'
    if [ $((i % 9)) -eq 0 ]; then printf '    db.query("select * from t%s where id = ?", x)\n' "$i"; fi
    if [ $((i + 7)) -le 60 ]; then printf '    return m%s.step(x)\n' $((i + 7)); else printf '    return x\n'; fi
    filler "$i"
  } > app/domain/m$i.py
done
# web/h1..h12: handler hN starts the chain at domain mN
for h in $(seq 1 12); do
  { printf 'from app.domain import m%s\n\n\ndef handle(req):\n    return m%s.step(req["id"])\n' "$h" "$h"; filler "h$h"; } > app/web/h$h.py
done
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
