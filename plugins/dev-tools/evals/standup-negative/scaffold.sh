#!/usr/bin/env bash
# A tiny repo with a work-in-progress note; the prompt asks a general concept question instead.
set -euo pipefail
cat > STATUS.md <<'MD'
# Billing export

Goal: let customers download their invoices as CSV.
Done: export endpoint merged (PR 12).
In progress: CSV formatting, PR 13, checks passing, waiting for approval.
Not started: docs page.
MD
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
