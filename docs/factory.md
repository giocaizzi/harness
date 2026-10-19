# Factory

The `factory` plugin works tickets from a GitHub issue board, one at a time and attended: a person starts each run, and the agent carries the ticket from plan to merged, deployed and verified work. It is generic: anything particular to a repo (owners, labels, components, checks, deploys, risk tiers) is read at run time from that repo's `.factory/` folder. Adopting it in a repo: [adopt-factory.md](adopt-factory.md).

## Principles

- **The owner picks which tickets; the agent owns finishing them.** A ticket is worked only when an approver applied the approval label. Everything the ticket needs to be done is then in scope, and nothing else.
- **The ticket is the shared record.** Plans, questions, scope decisions and evidence go on the issue as comments, so whoever runs the next step (a person, a subagent, a later headless process) starts from the same state.
- **A contract, not code.** A run starts from a ticket and ends with a marked result comment on it and a `result.json`. Nothing else is assumed about what runs it, so a runtime can come later without changing the skills.
- **Never a decision by silence.** A question parks the ticket until an approver answers on it. The agent never closes, re-scopes or marks an issue not planned; only its own PR's `Closes #N` closes the ticket.

## Attended flow

The `ticket-run` skill carries one ticket through these steps; call it with the issue number, and again on a parked ticket once you have answered. `factory-status` lists what needs you, what is in progress and what is done, from the labels and marked comments.


1. **Gate.** The ticket is open and carries the approval label, and the issue timeline shows an approver applied it. Otherwise the run stops and says why.
2. **Plan comment.** Goal, acceptance checks (each one a command or observation that fails before the change), side effects in scope, planned fold-ins, size and risk tier. XS and S tickets start right after it; M and larger post it as a question and park until the owner's OK.
3. **Work** in its own worktree and branch, applying the fold-in test to everything found on the way and logging each call in the decision log.
4. **Questions** go on the ticket, one per comment, and park the ticket (below).
5. **Verify** with a fresh-context verifier that is never the author.
6. **Ship and land**: one PR with `Closes #N` and the decision log as `## Scope`; merged per the risk tier (auto-merge or the owner).
7. **Deploy and live-verify** where the component has a deploy, then post the evidence and the result.

## Labels

| Label (config key) | Default | Set by | Meaning |
|---|---|---|---|
| `labels.approval` | `agent-ok` | an approver, only | The ticket may be worked. The agent never adds it, and removes it only after three parks. |
| `labels.claimed` | `factory-claimed` | the agent | A run holds the ticket (see [Claims](#claims)). Removed when the run ends. |
| `labels.needs_owner` | `needs-owner` | the agent | A question waits on the owner. Removed when the run resumes on an answer. |
| `labels.needs_grooming` | `needs-grooming` | the agent | Three parks: the ticket is under-specified and goes back to the owner for refinement. |

When the repo has a project board (`board` in the config), the agent also sets its status field: in progress while working, blocked while parked.

## Comments

Every comment the agent posts starts with two hidden lines: the marker (config `marker`, default `<!-- factory -->`) and a kind tag. The marker is what tells an agent comment from the owner's when both are posted under the same account.

| Kind tag | Posted | Body |
|---|---|---|
| `<!-- factory:claim -->` | when a run claims the ticket | Host, run id, runner (`attended`, `headless`, `runtime`). |
| `<!-- factory:plan -->` | once at the start, edited in place | Goal, acceptance checks, side effects in scope, planned fold-ins, size, risk tier. M and larger end by asking for the owner's OK. |
| `<!-- factory:question Q<n> -->` | per question | One question, the options, a recommendation with its reason, and what is done so far. |
| `<!-- factory:log -->` | once, edited in place | The decision log: one row per item found and the call made on it. Mirrored as `## Scope` in the PR. |
| `<!-- factory:result <end_state> -->` | at the end of each run | End state, PR, evidence links, follow-ups. The same facts as `result.json`. |

Posting is idempotent: before posting, the agent looks for its own comment of the same kind and edits it instead; a write counts only once the forge's API confirms it, and an unconfirmed one is recorded as `maybe_posted` and checked by its marker before any retry. Statuses in a comment are read from their live source just before posting, and links are copied from the API's URL fields.

**Answers.** The answer to an open question is the newest comment after it that an approver wrote and that does not carry the marker. Comments by any other account are ignored. A run resumes only on such an answer; with none, the ticket stays parked.

**Parks.** A question sets `needs-owner` (and the board's blocked status) and ends the run. After the third question on one ticket, the agent sets `needs-grooming`, removes the approval label and stops.

## Claims

A claim is visible on the forge, never only a local lock, so runs on different hosts never take the same ticket. A run claims a ticket by adding the claim label and posting a `factory:claim` comment with its host and run id, and releases it by removing the label when it ends, in any end state. A run that finds the label with another run's claim stops. A claim left by a run that died is cleared by the owner, by removing the label. A runtime on several hosts uses the same protocol; the race between two claims at the same moment is its to settle (for example by re-reading the newest claim comment after posting).

## Readiness

A ticket is ready when its body has acceptance criteria and a proof command: a command or observation that shows it done. A ticket that is approved but not ready gets a question proposing both, not a start.

## Scope: the fold-in test

Anything found during the work is in scope when an acceptance check needs it, when it is a side effect of the change (migrations, tests, docs and runbooks, generated types, config, deploy, live verification), or when it is entangled with the changed code so that fixing it later means reworking this change. Side effects are always in.

An in-scope item that is not a must-have is folded in by the agent alone only if it stays in the ticket's component, grows the ticket by at most one size step, does not raise the risk tier, and needs no owner or product decision. Otherwise the agent asks. Items that are not in scope are separate work: the agent searches for an existing issue and comments there, or opens one new backlog issue grouping related findings, never with the approval label. There is no numeric cap; flooding is watched through how many agent-filed issues end as duplicates or not planned.

## Verification

Before the PR ships, a fresh-context `verifier` agent that did not write the change checks four things: every changed hunk traces to an acceptance check or a decision-log row; every side effect is in the diff; each acceptance check has evidence that could have failed; and the PR carries the whole scope and `Closes #N`. It reports only what blocks the merge.

Its definition pins the model and effort, since a subagent with neither inherits the session's model and price: Opus at `high`, the one preset above `medium` in `subagent-orchestration`, because it is the last gate before a ticket ships. Trivial changes (XS, docs-only, config-only) are verified on Sonnet at `medium`, or `low` when a deterministic check fully covers them, set on the spawn; nothing goes above `high`. A verifier finding counts only when it blocks the merge and says how to show the failure, and a check that is syntax-only or failed to start is not evidence. Where a harness runs no subagent, the verifier runs as a separate session given the same brief (on pi, the `subagent` tool already starts one).

## Models and cost

Each phase runs on the cheapest model that does it well, set explicitly on every spawn because a subagent with no model inherits the session's price: lookups on the scout tier, XS and S implementation with clear acceptance checks on Sonnet, M and larger or brownfield work on Opus, verification as above, escalation per `subagent-orchestration`. A run costs its turns times the context each resends, so every phase gets a real check to finish in fewer turns. `result.json` records harness, model, effort, turns and cost where the harness reports them, so runs can be compared. A headless run takes its per-ticket cap from the harness's budget limit where one exists (Claude Code: `--max-budget-usd`, print mode only). The agent-facing table: `ticket-run`'s `references/routing.md`.

## Definition of done

The whole scope is merged in one PR that closes the ticket (no partial PRs, no `Refs`-only PR); the component's deploy finished and its live checks passed, where it has a deploy; the evidence and the result are posted on the ticket.

## Result contract

Each run writes `.factory/runs/<number>/result.json` in the repo's main checkout (not in the worktree, so it outlives it; `.factory/runs/` is git-ignored). It is overwritten by each run on the same ticket. Template: [`plugins/factory/template/result.json`](../plugins/factory/template/result.json).

| Key | Type | Meaning |
|---|---|---|
| `schema` | integer | Contract version, `1`. |
| `ticket` | string | `<owner>/<repo>#<number>`. |
| `run_id` | string | The main session's id where the harness exposes one, else `<host>-<number>-<UTC timestamp>`. Also in the claim comment. |
| `end_state` | `done` \| `parked` \| `failed` \| `budget_reached` | `done`: merged, deployed and verified per the definition of done. `parked`: waiting on the owner (a question, the M+ plan, a merge, or three parks). `failed`: could not be finished for a reason the owner must look at. `budget_reached`: a budget cap stopped the run; a pause, not a failure. |
| `reason` | string | Why the run parked or failed; empty when done. |
| `pr` | string \| null | The PR URL, if one exists. |
| `decisions` | array | The decision log rows: `item`, `test` (`R1`, `R2`, `R3` or `separate`), `decision` (`folded`, `asked`, `noted`, `filed`, `commented`), `where` (commit, issue or comment). |
| `evidence` | array of URLs | Comments, check runs or deploy runs that prove the acceptance checks. |
| `checks` | array | `{command, result}` per check run, `result` one of `pass`, `fail`, `not_run` (with a `note` on why). |
| `follow_ups` | array of URLs | Issues opened or commented for separate work. |
| `posts` | array | `{kind, url, state}` per comment written, `state` one of `posting`, `posted`, `maybe_posted`. |
| `cost_usd` | number \| null | Run cost when the harness reports it, else `null`. |
| `tokens` | object \| null | `{input, output, cache_read, cache_write}` when the harness reports them. |
| `turns` | integer \| null | Model turns in the run when the harness reports them, else `null`. |
| `harness` | string | `claude-code`, `copilot-cli`, `vscode`, `codex`, `opencode` or `pi`. |
| `model` | string | The model id as the harness reports it. |
| `effort` | string \| null | The session's effort level (`low` to `max`), or `null` when the harness has none. |
| `sessions` | array | `{role, id, model, effort}` per harness session in the run (`main`, `verifier`, other subagents), as the harness reports them rather than as requested, so a silent downgrade shows. The id joins the run to its telemetry's `session.id`. |
| `plugin_versions` | object | Plugin name to installed version for the harness plugins the run used (`factory`, `dev-tools`, ...). |
| `host` | object | `{name, os, runner}`: host name, `darwin`, `linux` or `windows`, and `attended`, `headless` or `runtime`, so runs from several machines can be told apart. |
| `finished_at` | string | ISO 8601 timestamp. |

**Telemetry.** `sessions` and `plugin_versions` let a run be joined to the harness's OpenTelemetry data by `session.id` and compared across plugin versions. A runtime may also tag a run's telemetry through `OTEL_RESOURCE_ATTRIBUTES` (for example `factory.run_id`, `factory.ticket`, `factory.role`, `factory.phase`); the skills emit nothing themselves.

## Config: `.factory/config.yaml`

Template with placeholders: [`plugins/factory/template/config.yaml`](../plugins/factory/template/config.yaml).

| Key | Required | Meaning |
|---|---|---|
| `version` | yes | Config format, `1`. |
| `forge` | yes | `github`, the only forge implemented. The skills express each operation as an intent (read the timeline, label, comment, search issues, open a PR) mapped to the forge's CLI, so GitLab or Azure DevOps can be added the way `repo-standard` maps them. |
| `approvers` | yes | GitHub logins whose label and comments count as the owner's. |
| `labels` | no | `approval`, `claimed`, `needs_owner`, `needs_grooming`; defaults as in [Labels](#labels). |
| `marker` | no | Hidden first line of every agent comment; default `<!-- factory -->`. |
| `size_label_prefix` | no | Label prefix that carries the ticket's size (`XS`, `S`, `M`, `L`, `XL`). Without it, the plan estimates the size. |
| `board` | no | `owner`, `project` (number), `status_field` and the `status` option names for `in_progress`, `blocked` and `backlog`. Omit when there is no board. |
| `components` | yes | Per component: `paths` (globs), `checks` (commands that prove a change), and optional `deploy` with `wait`, `verify` (commands; `$SHA` is the merge commit) and `rollback`. |
| `notify` | no | How a runtime tells the owner a question waits: `command` (reads the message on stdin) or `url`. Unused by attended runs. |
| `telemetry` | no | `resource_attributes` a runtime sets on a run's telemetry. The OTLP endpoint comes from the environment (`OTEL_EXPORTER_OTLP_ENDPOINT`), never from this file. |
| `secrets` | no | Name to `{provider, ref}`: secrets the deploy and verify commands need, by reference through the `secrets-handling` providers, never values. |
| `risk` | yes | Tiers lowest first, each with `tier`, `paths` (globs) and `merge` (`auto` or `owner`). A change takes the highest tier any path matches; unmatched paths are `medium`. |

## Layers and what is not built yet

The factory has three layers:

- **Skills:** the method (`ticket-run`, `factory-status`, the `verifier`), portable across harnesses.
- **Contract:** the ticket, its labels, the marked comments and `result.json`.
- **Runtime:** the execution layer that hosts runs on one or more hosts: polling and scheduling, claims, supervision, harness adapters, identity and tokens, permission and sandbox profiles, budgets, telemetry tagging, notifications and self-healing. Unattended overnight work ("drain") is one runtime policy.

This slice ships the skills and the contract; the runtime is not part of it, and is built only when attended runs show it is needed. Nothing here assumes a host: paths are relative to the repo or worktree, commands are the forge's CLI and `git`, and the contract records which host and runner made each run.
