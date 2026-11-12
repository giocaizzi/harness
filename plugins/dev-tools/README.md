# `dev-tools` plugin

General development tooling — git, GitHub/GitLab/Azure DevOps, conventional commits, semantic versioning, automated releases.

## Skills

| Skill | Description |
|---|---|
| `conventional-commits` | Conventional Commits 1.0.0 — type, scope, breaking change, and bump semantics. |
| `semver` | Semantic Versioning 2.0.0 — choosing major, minor, and patch from compatibility impact. |
| `release-please` | Automated versioning, changelog, and tagging from Conventional Commits. |
| `github-pull-requests` | The branch lifecycle (push every commit, draft PR first), stacked PRs, auto-merge, merge queues, and rulesets with required CI checks. |
| `ci-cd` | CI/CD on any platform: job graph and critical path, parallelism and sharding, run concurrency and deploy locks, caching, change detection, flakes, build-once delivery; GitLab, Azure Pipelines and Jenkins spellings in its references. |
| `github-actions` | GitHub Actions: `merge_group`, concurrency, the aggregate `check`, drafts without CI, tiers, job-level path filters, caches, permissions and OIDC, flakes, measuring Actions minutes. |
| `repo-standard` | Repo baseline checklist and its mapping onto GitHub, GitLab and Azure DevOps. |
| `ship` | Commit as Conventional Commits, push every commit and open a draft PR on the first push (`/ship`). |
| `land` | Watch CI, merge via auto-merge or queue, sync, clean up and verify where it lands (`/land`, also for "verify"). |
| `pr-fix` | Fix unresolved review comments and failing CI on a PR (`/pr-fix`). |
| `wt` | Start a task in its own worktree from an issue or slug (`/wt`). |
| `host-hygiene` | Shared-host rules and scripts: disk floor, load cap, heavy-command semaphore, device leases, service registry, repo sweep of leftover worktrees, branches and stashes, quota-aware agent fan-out. |
| `unattended-runs` | Overnight, autopilot and headless runs: `GUARD_UNATTENDED`, what guard denies, worktree and quota prep, what to leave for a human. |
| `standup` | Plain-language status: a 3-line story, a numbered "Needs you" list you approve with `all`, then done and in flight; `detail` adds refs, `explain <topic>` explains one part of the work (`/standup`). |
| `docs-sync` | Update docs and runbooks the diff made stale (`/docs-sync`). |
| `secrets-handling` | Bitwarden (bw, bws), keyrings and encrypted config; secrets never printed or inlined. |
| `subagent-orchestration` | Which agent takes which work (judgement to `driver`, edits to `worker`, lookups to `scout`, review to `reviewer`), spawn rules, escalation and gotchas; tiers per harness and review rounds in its references. |

## Agents

| Agent | Description |
|---|---|
| `scout` | Read-only search and summarization on a cheap model; reports findings with evidence. |
| `worker` | Routine-tier engineer for edits whose every decision is made (a written plan, a rename, a rollout, one unit of a driver's split), in its own worktree on a local branch it never pushes; stops on any unsettled choice. |
| `driver` | Driver-tier engineer a hub hands judgement work to: investigates, plans and splits it, fans the edits out to parallel `worker`s and integrates them in its own worktree. |
| `reviewer` | Routine-tier reviewer of a change it did not write, raised to the driver tier at `high` effort on the spawn for a sensitive review; maintains and refactors tests, adds x-failing tests to prove issues, and posts a verdict with severities. Never edits production code. |
| `escalate` | Strongest-tier engineer for work a `driver` failed twice on; returns the user's decisions as open questions. |

On pi, which has no subagents or interactive questions, `pi/subagent.mjs` runs these agents (and every other plugin's, such as `foundations`' `api-reviewer`) as a `subagent` tool (each in its own `pi -p` session), and provides an `ask_question` tool (mapped from `AskUserQuestion`) with a 60-second timeout.

## Install

```bash
# Claude Code / Copilot CLI / Codex (codex plugin add)
/plugin install dev-tools@giocaizzi-harness
```

Every harness (Codex, opencode and pi included), updates and local development: [docs/install.md](../../docs/install.md).
