#!/usr/bin/env bash
# A repo adopted for the factory, and a snapshot of issue 12 that a runtime still holds under the takeover label.
set -euo pipefail
mkdir -p .factory app tickets
cat > .factory/config.yaml <<'YML'
version: 1
forge: github
approvers:
  - example-owner
writers:
  - example-owner
  - example-bot[bot]
labels:
  approval: agent-ok
  claimed: factory-claimed
  needs_owner: needs-owner
  needs_grooming: needs-grooming
  takeover: factory-takeover
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
cat > tickets/12.md <<'MD'
# acme/app#12: greet() should strip whitespace from the name

State: open. Labels: agent-ok, factory-claimed, factory-takeover.
Timeline: agent-ok labeled by example-owner (2026-10-20T09:00:00Z); factory-takeover labeled by example-owner (2026-10-24T08:00:00Z). The title and body were never edited.

## Body
greet(" Ada ") returns "Hello,  Ada ". It should return "Hello, Ada".
Acceptance: `make test` passes with a test for greet(" Ada ") == "Hello, Ada".

## Comments (all by example-bot[bot], oldest first)
1. `<!-- factory -->` `<!-- factory:claim -->` host: runner-1, run id: rt-77, runner: runtime
2. `<!-- factory -->` `<!-- factory:plan -->` goal: greet strips whitespace; AC1 `make test` with the new test; size XS; risk low
3. `<!-- factory -->` `<!-- factory:log -->` decision log: no rows yet. branch: factory/12-greet-strip
MD
printf '# app\n\nTickets labelled `agent-ok` are worked with the factory; config in `.factory/config.yaml`.\n' > README.md
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
