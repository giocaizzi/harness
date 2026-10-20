# Finish: verify, ship, land, deploy, record

## Checklist

Keep the run's checklist in `.factory/runs/N/checklist.md` of the main checkout (git-ignored, so it never enters the diff): acceptance checks with their state, open fold-ins, what is pushed. Update it as you go; after a compaction or a resume, read it before anything else.

## Verify

A fresh-context `verifier` (this plugin's agent) gates the change; it must not be you. Brief it with the ticket (`<owner>/<repo>#N`), the branch, and the plan and log comments.

- **Where:** a subagent where the harness has one (`factory:verifier` in Claude Code; the `verifier` agent in Copilot CLI, VS Code, Codex and opencode; the `subagent` tool on pi). Elsewhere, a separate headless session in the worktree, given the agent's prompt and the brief.
- **Model and effort:** its preset, Opus at `high`. For trivial changes (XS, docs-only, config-only) spawn it on Sonnet at `medium`, or `low` when a deterministic check fully covers the change, where the harness takes them per spawn ([routing.md](routing.md)). Never above `high`.
- **Rounds:** fix what it reports, then have it re-review only the new diff; at most three rounds. Still failing: ask on the ticket with its findings and park.

## Ship and land

`ship`, using the repo's PR template if it has one. Otherwise the body carries `## Scope` (the decision log), the acceptance evidence as the testing under `## Verification`, `## Risk` (tier and why) and `## How to revert`, with `Closes #N` among the footers. Then land by the change's risk tier (the highest `risk` tier any changed path matches; unmatched paths are medium):

- `merge: auto`: `land`.
- `merge: owner`: ask on the ticket for the merge (`Ready to merge: #<pr>`, with the evidence) and park. The next run resumes once the PR is merged.

## Deploy and live-verify

Only for components with `deploy` in the config. With the merge commit as `$SHA` (`gh pr view <pr> --json mergeCommit --jq .mergeCommit.oid`), run `deploy.wait`, then each `deploy.verify`, and post their output or run links as evidence on the ticket. Secrets they need come by reference (config `secrets`, through `secrets-handling`), never as values.

A failed live check means the change does not work where it lands: open a revert PR of the merge commit, land it by the same tier, then ask on the ticket with the findings and park. `deploy.rollback` is for when the config names a command and a revert is not enough. A check that needs access you lack parks with the exact command for the owner.

## Record

Every run ends with both, and releases its claim:

1. The result comment (kind `factory:result`, [comments.md](comments.md#comments)).
2. `.factory/runs/N/result.json` in the main checkout, which outlives the worktree (the parent of `git rev-parse --path-format=absolute --git-common-dir`). Keys: `schema` (2), `ticket`, `run_id`, `end_state`, `reason`, `reason_code`, `pr`, `decisions` (the log rows: `item`, `test`, `decision`, `where`), `evidence`, `checks` (`command`, `result`), `follow_ups`, `posts` (`kind`, `url`, `state`), `phases` (`name`, `started_at`, `ended_at`), `verifier` (`verdict`, `rounds`), `cost_usd`, `tokens`, `turns`, `harness`, `model`, `effort`, `sessions` (`role`, `id`, `model`, `effort`), `plugin_versions`, `host` (`name`, `os`, `runner`), `finished_at`; their meaning is in `docs/factory.md` (Result contract).

Record what the harness reports, not what you asked for: a model or effort that differs from the requested one is how a silent downgrade shows. Fields the harness does not expose are `null`. `end_state` is `budget_reached` when a budget cap stopped the run, which is not a failure; never write `halted`, which only a runtime writes.

- **`run_id`:** `FACTORY_RUN_ID` when it is set, so the result matches the runtime's claim.
- **`reason_code`:** the park or failure as one code, `null` when done or none fits; the specific cause wins over `question` when a park also asks one: a question `question`, the M+ plan waiting for the OK `plan_gate`, an owner merge `merge_gate`, the third park `grooming`, the verifier still failing after three rounds `verify_rounds`, a failed live check `live_verify_failed`, missing access or a broken environment `env_blocked`, a budget cap `budget`, a credential or token failure `auth`.
- **`phases`:** one entry per step reached, in order (`gate`, `plan`, `work`, `verify`, `ship`, `deploy`, `record`), with the time you entered and left it; `ended_at` is `null` for the step the run stopped in. Note the times in the checklist as you go.
- **`verifier`:** its last verdict and the number of rounds; `null` when the run stopped before the verifier.

A parked ticket keeps its worktree and pushed branch for the next run.
