# Plan and apply flow

An interface for the CI workflow, not a template. Any CI system fits.

| Stage | Trigger | Identity | Runs | Artifact |
|---|---|---|---|---|
| Check | every PR | none (no state) | `fmt -check`, `init -backend=false`, `validate`, tflint, `terraform test` | none |
| Plan | PR touching `envs/<env>/` or a module it uses | read-only, federated (OIDC) | `init`, `plan -out=tfplan -lock-timeout=<d>`, `show` of the plan | `tfplan` and its rendered text, bound to the commit SHA |
| Review | PR | humans | read the rendered plan; destroys and replacements called out | approval |
| Apply | merge to the default branch | write, federated, scoped to the environment | `apply -lock-timeout=<d> tfplan` | apply log |
| Drift | schedule | read-only | `plan -detailed-exitcode -lock=false` | report or issue; never applied |

## Constraints

- The apply stage applies the plan artifact produced for that commit. If state moved, the plan is stale: fail and re-plan, do not apply fresh.
- The plan artifact can hold secrets: restrict its access and retention like state.
- Identities are short-lived and exchanged at run time; no stored cloud keys. Write access is granted only to the apply stage on the protected branch.
- Prod apply needs a required approval (protected environment) and stays disabled until the activation checklist in STRUCTURE.md is done.
- A failed or cancelled job that held the lock is resolved by a human with `force-unlock` and the printed lock ID, after confirming no run is live.
- Drift uses `-lock=false` only because it is read-only; never for plans that feed an apply.
