#!/usr/bin/env bash
# A state snapshot of a session whose changes form a stack, so "explain" has a topic of the current work.
set -euo pipefail
cat > STATE.md <<'MD'
# Session state: billing export (acme/app)

Goal: let customers download their invoices as CSV.

Changes, stacked (each is a PR built on the previous one):
- PR 12 export endpoint: merged into main
- PR 13 CSV formatting: base is PR 12's branch, checks passing, waiting for approval
- PR 14 download button: base is PR 13's branch, checks failing, blocked on PR 13

Merge rule: the main branch uses a merge queue; a change merges only after its base has merged and it has been rebased onto main.
MD
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
