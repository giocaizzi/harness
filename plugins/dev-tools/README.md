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
| `land` | Watch CI, merge via auto-merge or queue, sync, clean up and verify where it lands (`/land`, also for "verify"). |
| `pr-fix` | Fix unresolved review comments and failing CI on a PR (`/pr-fix`). |
| `wt` | Start a task in its own worktree from an issue or slug (`/wt`). |
| `host-hygiene` | Shared-host rules and scripts: disk floor, load cap, heavy-command semaphore, device leases, service registry, stale-worktree sweep, quota-aware agent fan-out. |
| `unattended-runs` | Overnight, autopilot and headless runs: `GUARD_UNATTENDED`, what guard denies, worktree and quota prep, what to leave for a human. |
| `standup` | Terse status: done, in flight, waiting on you, leftovers (`/standup`). |
| `docs-sync` | Update docs and runbooks the diff made stale (`/docs-sync`). |
| `secrets-handling` | Bitwarden (bw, bws), keyrings and encrypted config; secrets never printed or inlined. |
| `subagent-orchestration` | Which agent takes which work (judgement to `driver`, edits to `worker`, lookups to `scout`, review to `reviewer`), spawn rules, escalation and gotchas; tiers per harness and review rounds in its references. |

## Agents

| Agent | Description |
|---|---|
| `scout` | Read-only search and summarization on a cheap model; reports findings with evidence. |
| `worker` | Routine-tier engineer for edits whose every decision is made (a written plan, a rename, a rollout); stops on any unsettled choice. |
| `driver` | Driver-tier engineer a hub hands judgement work to: investigates, plans, implements and integrates in its own worktree. |
| `reviewer` | Driver-tier reviewer of a change it did not write; posts a verdict with severities, at most two rounds. |
| `escalate` | Strongest-tier engineer for work a `driver` failed twice on; returns the user's decisions as open questions. |

On pi, which has no subagents, `pi/subagent.mjs` runs these agents (and every other plugin's, such as `api`'s `api-reviewer`) as a `subagent` tool, each in its own `pi -p` session.

## Install

```bash
# Claude Code / Copilot CLI / Codex (codex plugin add)
/plugin install dev-tools@giocaizzi-harness
```

Every harness (Codex, opencode and pi included), updates and local development: [docs/install.md](../../docs/install.md).
