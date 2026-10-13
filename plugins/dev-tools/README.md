# `dev-tools` plugin

General development tooling — git, GitHub/GitLab/Azure DevOps, conventional commits, semantic versioning, automated releases.

## Skills

| Skill | Description |
|---|---|
| `conventional-commits` | Conventional Commits 1.0.0 — type, scope, breaking change, and bump semantics. |
| `semver` | Semantic Versioning 2.0.0 — choosing major, minor, and patch from compatibility impact. |
| `release-please` | Automated versioning, changelog, and tagging from Conventional Commits. |
| `github-workflow` | Stacked PRs, auto-merge, merge queues, and rulesets with required CI checks. |
| `repo-standard` | Repo baseline checklist and its mapping onto GitHub, GitLab and Azure DevOps. |
| `ship` | Commit as Conventional Commits, push and open a PR (`/ship`). |
| `land` | Watch CI, merge via auto-merge or queue, sync and clean up (`/land`). |
| `pr-fix` | Fix unresolved review comments and failing CI on a PR (`/pr-fix`). |
| `wt` | Start a task in its own worktree from an issue or slug (`/wt`). |
| `host-hygiene` | Shared-host rules and scripts: disk floor, load cap, heavy-command semaphore, device leases, service registry, stale-worktree sweep, quota-aware agent fan-out. |
| `docs-sync` | Update docs and runbooks the diff made stale (`/docs-sync`). |
| `secrets-handling` | Bitwarden (bw, bws), keyrings and encrypted config; secrets never printed or inlined. |
| `subagent-orchestration` | Hub-and-spoke delegation, model tiers, effort levels, escalation and verification. |

## Agents

| Agent | Description |
|---|---|
| `scout` | Read-only search and summarization on a cheap model; reports findings with evidence. |
| `escalate` | Hard-problem solver on the strongest model, for work that stalled twice. |

## Install

```bash
# Claude Code / Copilot CLI / Codex (codex plugin add)
/plugin install dev-tools@giocaizzi-harness
```

Every harness (Codex, opencode and pi included), updates and local development: [docs/install.md](../../docs/install.md).
