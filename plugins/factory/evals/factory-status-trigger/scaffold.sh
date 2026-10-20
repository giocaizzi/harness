#!/usr/bin/env bash
# A small repo adopted for the factory: a .factory/config.yaml with placeholder values and one component.
set -euo pipefail
mkdir -p .factory app
cat > .factory/config.yaml <<'YML'
version: 1
approvers:
  - example-owner
labels:
  approval: agent-ok
  needs_owner: needs-owner
  needs_grooming: needs-grooming
components:
  app:
    paths:
      - "app/**"
    checks:
      - "make test"
risk:
  - tier: low
    paths:
      - "**/*.md"
    merge: auto
YML
cat > app/main.py <<'PY'
def greet(name: str) -> str:
    return f"Hello, {name}"
PY
printf '# app\n\nTickets labelled `agent-ok` are worked with the factory; config in `.factory/config.yaml`.\n' > README.md
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
