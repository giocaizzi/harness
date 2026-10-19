# Verify, ship, land, deploy, record

Done means: the whole scope is merged in one PR that closes the ticket; where the component deploys, the deploy finished and its live checks passed; the evidence and the result are on the ticket.

## 1. Verify with a fresh context

The `verifier` agent (this plugin) checks traceability, side effects and acceptance evidence. It must not be you: spawn it with a self-contained brief naming the ticket (`<owner>/<repo>#N`), the branch, and the plan and log comments.

- **Where:** a subagent where the harness has one (`factory:verifier` in Claude Code, the `verifier` agent in Copilot CLI, VS Code, Codex and opencode, the `subagent` tool on pi). Elsewhere, a separate headless session in the worktree given the agent's prompt and the brief.
- **Effort:** `high`, its preset. Pass `medium` for trivial changes (XS, docs-only, config-only), or `low` when a deterministic check fully covers the change, where the harness takes an effort per spawn. Never above `high`.
- **Rounds:** fix what it reports and re-verify only the new diff, at most three rounds. Still failing after three: end the run as `failed`, with its findings in the result comment and the needs-owner label.

## 2. Ship

Use `ship`. The PR body carries the decision log as `## Scope`, the acceptance evidence under `## Verification`, and `Closes #N` among the footers. Never `Refs` alone for the ticket.

## 3. Land by risk tier

The change's tier is the highest `risk` tier any changed path matches (unmatched paths are medium).

- `merge: auto`: land with `land`, which arms auto-merge and waits.
- `merge: owner`: leave the PR for the owner. Post a question on the ticket (`Ready to merge: #<pr>`, with the evidence), park, and stop. The run resumes once the PR is merged and continues with the deploy.

## 4. Deploy and live-verify

Only for components with `deploy` in the config. With the merge commit (`gh pr view <pr> --json mergeCommit --jq .mergeCommit.oid`) as `$SHA`, run `deploy.wait`, then every `deploy.verify` command. Post their output, or links to the runs, as evidence on the ticket.

A failed live check means the change does not work where it lands: open a revert PR (`git revert` of the merge commit) and land it by the same tier, then ask on the ticket with the findings and park. Use `deploy.rollback` only when the config names a command and the revert is not enough. When a check needs access you do not have, park with the exact command for the owner.

## 5. Record the result

1. Post the result comment (`<!-- factory:result <end_state> -->`, see [comments.md](comments.md#comment-shapes)) with the PR, the evidence links and the follow-ups.
2. Write `result.json` in the main checkout, which outlives the worktree: the directory above `git rev-parse --path-format=absolute --git-common-dir`, then `.factory/runs/N/result.json`. Keys: `schema` (1), `ticket`, `end_state`, `reason`, `pr`, `decisions` (the log rows: `item`, `test`, `decision`, `where`), `evidence`, `follow_ups`, `cost_usd`, `harness`, `model`, `finished_at`; their meaning is in `docs/factory.md` (Result contract). `cost_usd` only when the harness reports it, else `null`.
3. Every run writes one, `done`, `parked` or `failed`, so the next run, or whatever starts it, reads the same state.

Then `land` cleans up the worktree after a merge; a parked ticket keeps its worktree and pushed branch.
