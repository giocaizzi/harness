#!/usr/bin/env bash
# A state snapshot of a finished session: merged and open changes, a decision, leftovers.
set -euo pipefail
cat > STATE.md <<'MD'
# Session state: billing export (acme/app)

Goal: let customers download their invoices as CSV.

Changes (a stack, each built on the previous one):
- PR 12 export endpoint: merged (SHA a1b2c3d)
- PR 13 CSV formatting: checks passing, auto-merge not enabled, waiting for approval
- PR 14 download button: checks failing (lint error in button.ts), blocked on PR 13
- PR 15 docs page: not started
- PR 16 rate limit on the endpoint: not started

Open decisions:
- Date format in the CSV: ISO (2026-01-31) or local (31/01/2026). The orders team uses ISO. No decision yet.

Leftovers:
- worktree .claude/worktrees/export-endpoint, branch export-endpoint (PR 12 merged)
- /tmp/export-sample.csv (scratch file)

Running agents: none.
MD
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
