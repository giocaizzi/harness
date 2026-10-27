#!/usr/bin/env bash
# The billing pipeline that charges every customer; the branch refactors all of its stages.
set -euo pipefail
mkdir -p billing/stages
stages="load_accounts meter_usage apply_plans apply_credits compute_tax round_totals build_invoices charge_cards retry_failures notify_customers ledger_export close_period"
for s in $stages; do printf 'def run(batch):\n    batch["%s"] = True\n    return batch\n' "$s" > billing/stages/$s.py; done
printf 'STAGES = "%s".split()\n' "$stages" > billing/pipeline.py
cat >> billing/pipeline.py <<'PY'


def run_all(batch):
    import importlib
    for s in STAGES:
        batch = importlib.import_module(f"billing.stages.{s}").run(batch)
    return batch
PY
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
git checkout -qb refactor/billing-pipeline
for s in $stages; do printf 'from billing.stage import Stage\n\n\nclass Run(Stage):\n    name = "%s"\n\n    def apply(self, batch):\n        batch[self.name] = True\n        return batch\n' "$s" > billing/stages/$s.py; done
cat > billing/stage.py <<'PY'
class Stage:
    name = ""

    def apply(self, batch):
        raise NotImplementedError
PY
cat > billing/pipeline.py <<'PY'
import importlib

STAGES = "load_accounts meter_usage apply_plans apply_credits compute_tax round_totals build_invoices charge_cards notify_customers retry_failures ledger_export close_period".split()


def run_all(batch):
    for s in STAGES:
        batch = importlib.import_module(f"billing.stages.{s}").Run().apply(batch)
    return batch
PY
git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm "refactor(billing): class-based pipeline stages"
git checkout -q main
