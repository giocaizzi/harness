---
name: terraform
description: "Use when writing or changing Terraform or OpenTofu: .tf, .tfvars or .tftest.hcl files, modules, state, providers and the lockfile, importing or renaming a resource, or a plan or apply step in CI. Layout (modules, envs, bootstrap), remote state and locking, moved blocks, module versioning, provider pinning, drift, mock-provider tests. Not for Dockerfiles or Kubernetes manifests."
---

# Terraform and OpenTofu

Category: infrastructure operations. Works the same for OpenTofu (`tofu` for `terraform`). The opinions below are defaults; deviate only with a recorded reason.

## Opinions

1. Plans and applies run in CI/CD with short-lived federated identity (OIDC), never a local apply against shared state. A local plan needs explicit human approval: a killed plan can strand the state lock. Flow and stages: [PLAN_APPLY_FLOW.md](references/PLAN_APPLY_FLOW.md); the pipeline side (one run per state at a time, environments, the OIDC exchange) is `ci-cd`.
2. The local gate has no state and no lock: `fmt -check`, `validate`, tflint and module tests, run through make targets. Tests: [TESTING.md](references/TESTING.md).
3. Layout is `modules/`, `envs/<env>/` and `bootstrap/`; environments differ by variables, not by copied code. See [STRUCTURE.md](references/STRUCTURE.md).
4. Remote backend with locking, one state per environment, small blast radius. Never edit state by hand; `force-unlock` is human-only. See [STATE.md](references/STATE.md).
5. Refactors use `moved` blocks, never destroy and recreate. `for_each` with stable keys, not `count` indices. `prevent_destroy` on stateful resources.
6. Modules are small, versioned, hold no provider config, and carry their tests. See [MODULES.md](references/MODULES.md).
7. Commit `.terraform.lock.hcl`; pin providers and modules; upgrade them in their own change.
8. Secrets never in plain variables or outputs; state is a secret. Plan and apply use split identities (read vs write) where the platform allows. No long-lived keys.
9. A scheduled drift plan reports drift; it never applies. Required labels or tags on every taggable resource.

## Gotchas

- Apply the saved plan file from the reviewed plan, never a fresh `apply`: the world may have moved since review.
- Set `-lock-timeout` in CI so a concurrent run waits instead of failing.
- `force-unlock` takes the lock ID the tool prints, whose form is backend-specific; do not assume a UUID read from the lock file works.
- Data sources that call live APIs make plans flaky and offline tests impossible; pass values in as variables when you can.
- A provider block left to defaults (region, profile, endpoint from the environment) changes what a plan targets per machine; set them explicitly in the root.
- `terraform test` keeps its state in memory, but the directory must be initialized first: use `init -backend=false` locally.

## References

Load only what the task needs.

- [PLAN_APPLY_FLOW.md](references/PLAN_APPLY_FLOW.md): CI stages, identities, artifacts, approvals.
- [STATE.md](references/STATE.md): backend, locking, imports, moves, recovery.
- [MODULES.md](references/MODULES.md): module interface, versioning, providers.
- [TESTING.md](references/TESTING.md): `terraform test`, mock providers, make targets.
- [STRUCTURE.md](references/STRUCTURE.md): directory layout and promotion.
