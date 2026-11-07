# Infrastructure review rubric

For a reviewer assessing infrastructure changes: IaC (Terraform, Pulumi, CloudFormation, Bicep), containers, CI pipelines and cloud configuration. Report only failures, each with severity, location and fix.

Severity: **blocker** (do not merge), **major** (fix before release or accept in writing), **minor** (note).

## IaC

| # | Check | Severity |
|---|---|---|
| 1 | Plan or preview reviewed; no unexpected destroy or replace of stateful resources | blocker |
| 2 | Stateful resources have deletion protection, backups, `prevent_destroy` or equivalent | major |
| 3 | Remote state with locking and encryption; no state in git | blocker |
| 4 | Providers and modules pinned to versions | major |
| 5 | No secrets in code, variable defaults or outputs | blocker |
| 6 | Resources carry owner and environment tags | minor |
| 7 | Environments differ by variables, not copied code | minor |

## Cloud and IAM

| # | Check | Severity |
|---|---|---|
| 8 | Least privilege; no wildcard action with wildcard resource; one identity per workload | blocker |
| 9 | No long-lived access keys; workload identity or roles | major |
| 10 | Data stores and compute private; only the edge public; no `0.0.0.0/0` on admin or data ports | blocker |
| 11 | Encryption at rest and in transit | major |
| 12 | Backups exist and a restore was tested | major |
| 13 | Budget alert and cost estimate; no unbounded autoscaling | major |
| 14 | Region matches residency; zone redundancy matches the availability target | major |

## Containers

| # | Check | Severity |
|---|---|---|
| 15 | Base image pinned (tag and digest), minimal, maintained | major |
| 16 | Runs as non-root; read-only filesystem where possible | major |
| 17 | Multi-stage build; no build tools or secrets in the final image | major |
| 18 | Health probes, resource requests and limits set | major |
| 19 | Image scanned in CI; `.dockerignore` present | minor |

## CI

| # | Check | Severity |
|---|---|---|
| 20 | Third-party actions pinned to a commit SHA | major |
| 21 | Minimal token permissions per job | major |
| 22 | Secrets from the secret store, never echoed; untrusted PR code gets none | blocker |
| 23 | Required checks gate merge; deploy is separate, gated and reversible | major |
| 24 | Cache keyed on the lockfile; jobs have timeouts | minor |
| 25 | The same command runs locally and in CI | minor |

## Output

`<severity> #<n> <file:line>: <problem>. Fix: <action>.` End with a verdict: approve, approve with majors accepted, or block.
