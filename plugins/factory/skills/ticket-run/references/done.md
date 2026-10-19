# Finish: verify, ship, land, deploy, record

## Verify

A fresh-context `verifier` (this plugin's agent) gates the change; it must not be you. Brief it with the ticket (`<owner>/<repo>#N`), the branch, and the plan and log comments.

- **Where:** a subagent where the harness has one (`factory:verifier` in Claude Code; the `verifier` agent in Copilot CLI, VS Code, Codex and opencode; the `subagent` tool on pi). Elsewhere, a separate headless session in the worktree, given the agent's prompt and the brief.
- **Model and effort:** its preset, Opus at `high`. For trivial changes (XS, docs-only, config-only) spawn it on Sonnet at `medium`, or `low` when a deterministic check fully covers the change, where the harness takes them per spawn ([routing.md](routing.md)). Never above `high`.
- **Rounds:** fix what it reports and re-verify, at most three rounds. Still failing: end as `failed`, with its findings in the result comment and `needs-owner` set.

## Ship and land

`ship`, with the decision log as `## Scope` in the PR body, the acceptance evidence under `## Verification`, and `Closes #N`. Then land by the change's risk tier (the highest `risk` tier any changed path matches; unmatched paths are medium):

- `merge: auto`: `land`.
- `merge: owner`: ask on the ticket for the merge (`Ready to merge: #<pr>`, with the evidence) and park. The next run resumes once the PR is merged.

## Deploy and live-verify

Only for components with `deploy` in the config. With the merge commit as `$SHA` (`gh pr view <pr> --json mergeCommit --jq .mergeCommit.oid`), run `deploy.wait`, then each `deploy.verify`, and post their output or run links as evidence on the ticket.

A failed live check means the change does not work where it lands: open a revert PR of the merge commit, land it by the same tier, then ask on the ticket with the findings and park. `deploy.rollback` is for when the config names a command and a revert is not enough. A check that needs access you lack parks with the exact command for the owner.

## Record

Every run, `done`, `parked` or `failed`, ends with both:

1. The result comment (kind `factory:result`, [comments.md](comments.md#comments)).
2. `result.json` at `.factory/runs/N/result.json` in the main checkout, which outlives the worktree (the parent of `git rev-parse --path-format=absolute --git-common-dir`). Keys: `schema` (1), `ticket`, `end_state`, `reason`, `pr`, `decisions` (the log rows: `item`, `test`, `decision`, `where`), `evidence`, `follow_ups`, `cost_usd`, `turns`, `harness`, `model`, `effort`, `sessions` (`role`, `id`), `plugin_versions`, `finished_at`; their meaning is in `docs/factory.md` (Result contract). `cost_usd` and `turns` are `null` unless the harness reports them; `sessions` lists every session id the harness exposes, the verifier's and other subagents' included.

A parked ticket keeps its worktree and pushed branch for the next run.
