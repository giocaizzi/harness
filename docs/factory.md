# Factory

The `factory` plugin works tickets from a GitHub issue board, one at a time and attended: a person starts each run, and the agent carries the ticket from plan to merged, deployed and verified work. It is generic: anything particular to a repo (owners, labels, components, checks, deploys, risk tiers) is read at run time from that repo's `.factory/` folder. Adopting it in a repo: [adopt-factory.md](adopt-factory.md).

## Principles

- **The owner picks which tickets; the agent owns finishing them.** A ticket is worked only when an approver applied the approval label. Everything the ticket needs to be done is then in scope, and nothing else.
- **The ticket is the shared record.** Plans, questions, scope decisions and evidence go on the issue as comments, so whoever runs the next step (a person, a subagent, a later headless process) starts from the same state.
- **A contract, not code.** A run starts from a ticket and ends with a marked result comment on it and a `result.json`. Nothing else is assumed about what runs it, so a runtime can come later without changing the skills.
- **Only declared identities instruct a run.** Text from anyone outside `approvers` and `writers` is untrusted data: it describes at most a problem and never changes scope, steps, permissions or the plan. A ticket whose title or body anyone, an approver included, edited after the approval is not approved, an owner-gated merge resumes the ticket only when an approver merged it, and any change under `.factory/` lands as `merge: owner`. While a run is active the `guard` plugin denies any command that adds the approval label, since a token that is also an approver would make it the owner's.
- **Never a decision by silence.** A question parks the ticket until an approver answers on it. The agent never closes, re-scopes or marks an issue not planned; only its own PR's `Closes #N` closes the ticket.

## Attended flow

The `ticket-run` skill carries one ticket through these steps; call it with the issue number, and again on a parked ticket once you have answered. `factory-status` lists what needs you, what is in progress and what is done, from the labels and marked comments.

1. **Gate.** The ticket is open and carries the approval label, the issue timeline shows an approver applied it, and nobody, an approver included, edited the title or body since: the approval covers the text as it stood when the label was applied, and only an approver applying the label again restores it. Otherwise the run stops and says why.
2. **Plan comment.** Goal, acceptance checks (each one a command or observation that fails before the change), side effects in scope, planned fold-ins, size and risk tier. XS and S tickets start right after it; M and larger post it as a question and park until the owner's OK.
3. **Work** in its own worktree and branch, applying the fold-in test to everything found on the way and logging the calls the plan does not already cover in the decision log.
4. **Questions** go on the ticket, one per comment, and park the ticket (below).
5. **Verify** with a fresh-context verifier that is never the author.
6. **Ship and land**: one PR with `Closes #N` and the decision log as `## Scope`; merged per the risk tier (auto-merge or the owner).
7. **Deploy and live-verify** where the component has a deploy, then post the evidence and the result.

## Labels

| Label (config key) | Default | Set by | Meaning |
|---|---|---|---|
| `labels.approval` | `agent-ok` | an approver, only | The ticket may be worked. The agent never adds or removes it (in a runtime run the guard denies any command that names it). |
| `labels.claimed` | `factory-claimed` | the agent | A run holds the ticket (see [Claims](#claims)). Removed when the run ends. |
| `labels.needs_owner` | `needs-owner` | the agent | A question waits on the owner. Removed when the run resumes on an answer. |
| `labels.needs_grooming` | `needs-grooming` | the agent | Three parks: the ticket is under-specified and goes back to the owner for refinement. |
| `labels.quarantine` | `factory-quarantine` | a runtime | Repeated failed or stalled runs: a runtime stops picking the ticket until an approver removes the label. |
| `labels.halt` | `factory-halt` | an approver, an alert or a runtime | Set on an open issue (the halt issue): a runtime starts no run in the repo while any open issue carries it. |

When the repo has a project board (`board` in the config), the agent also sets its status field: in progress while working, blocked while parked.

## Comments

Every comment the agent posts starts with two hidden lines: the marker (config `marker`, default `<!-- factory -->`) and a kind tag. The marker is what tells an agent comment from the owner's when both are posted under the same account.

| Kind tag | Posted | Body |
|---|---|---|
| `<!-- factory:claim -->` | when a run claims the ticket | Host, run id, runner (`attended`, `headless`, `runtime`). A runtime may add the approval it pinned (`approved by`, `approved at`, `revision`); these are informational, never read back to decide anything. |
| `<!-- factory:plan -->` | once at the start, edited in place | Goal, acceptance checks, side effects in scope, planned fold-ins, size, risk tier. M and larger end by asking for the owner's OK. |
| `<!-- factory:question Q<n> -->` | per question | One question, the options, a recommendation with its reason, and what is done so far. |
| `<!-- factory:log -->` | once, edited in place | The decision log: one row per call the plan does not already cover. Mirrored as `## Scope` in the PR. |
| `<!-- factory:verdict <round> -->` | on the PR, once per verifier round | The verifier's verdict, verbatim from its verdict file; its first line names the head SHA it covers. |
| `<!-- factory:result <end_state> -->` | at the end of each run | End state, PR, evidence links, follow-ups. The same facts as `result.json`. |
| `<!-- factory:notify <kind> -->` | by a runtime only, when it must reach an approver | An @-mention of the approvers and one line on why, `<kind>` naming the event (for example `question`, `halt`, `quarantine`, `budget`). It carries the marker, so it is never read as an answer. |

Posting is idempotent: before posting, the agent looks for its own comment of the same kind and edits it instead; a write counts only once the forge's API confirms it, and an unconfirmed one is recorded as `maybe_posted` and checked by its marker before any retry. Statuses in a comment are read from their live source just before posting, and links are copied from the API's URL fields.

**Dev mode.** Under `FACTORY_DEV=1` (set by a runtime started in dev mode), every comment the run posts ends with a last field line `mode: dev`, so a dev run's output never passes as prod; every comment parser tolerates it as one more field line. See the [dev-mode rule](../plugins/dev-tools/skills/repo-standard/references/dev-mode.md).

**Authors.** A marked comment counts only when a writer wrote it: a login in `writers` (config), or in `approvers` when `writers` is unset, or the login the reading session itself posts as. Every other marked comment is ignored as if absent, wherever one is read (the skills, the `verifier`, `factory-status`, a runtime): it claims nothing, asks or answers nothing, records no plan, log or result, and is never edited in place. The marker alone proves nothing, since anyone who can comment on the repo can type it. A runtime that posts under its own login (a bot or GitHub App) must be listed in `writers`, or a session under the owner's login ignores its claims and notices; a repo whose runtime already posts that way adds `writers` when it takes factory 0.6.0, or its runtime-started runs stop at the gate. Logins are compared as the REST API reports them (`user.login`, an App as `<slug>[bot]`), ignoring case.

**Answers.** The answer to an open question is the newest comment after it that an approver wrote and that does not carry the marker (so a `factory:notify` mention never counts). Comments by any other account are ignored. Logins are compared ignoring case, as for writers, and an unset or empty `marker` means the default. A run resumes only on such an answer; with none, the ticket stays parked.

**Parks.** A question sets `needs-owner` (and the board's blocked status) and ends the run. After the third question on one ticket, the agent sets `needs-grooming` and stops; it leaves the approval label alone. A ticket with `needs-grooming` is not worked (the skill's gate and a runtime's poller both skip it). Removing `needs-grooming` re-admits the ticket; to re-approve it after grooming instead, the owner removes the approval label and applies it again.

## Claims

A claim is visible on the forge, never only a local lock, so runs on different hosts never take the same ticket. A run claims a ticket by adding the claim label and posting a `factory:claim` comment with its host and run id (a run a runtime started finds both already there, under the run id in `FACTORY_RUN_ID`, and edits that comment instead of posting a second), and releases it by removing the label when it ends, in any end state. A run that finds the label with another run's claim stops; only a claim comment by a writer (see [Authors](#comments)) is a claim. A claim left by a run that died is cleared by the owner, by removing the label. A runtime on several hosts uses the same protocol; the race between two claims at the same moment is its to settle (for example by re-reading the newest claim comment after posting).

## Readiness

A ticket is ready when its body has acceptance criteria and a proof command: a command or observation that shows it done. A ticket that is approved but not ready gets a question proposing both, not a start.

## Scope: the fold-in test

Anything found during the work is in scope when an acceptance check needs it, when it is a side effect of the change (migrations, tests, docs and runbooks, generated types, config, deploy, live verification), or when it is entangled with the changed code so that fixing it later means reworking this change. Side effects are always in.

The decision log holds only calls the approved plan does not already cover: fold-ins beyond the plan, questions, notes and follow-ups. Hunks that trace to an acceptance check and side effects the plan names get no row; changed existing test assertions get one `Existing tests changed: <test> (<old> → <new>, per AC<n>)` line in the PR's Verification section.

An in-scope item that is not a must-have is folded in by the agent alone only if it stays in the ticket's component, grows the ticket by at most one size step, does not raise the risk tier, and needs no owner or product decision. Otherwise the agent asks. Items that are not in scope are separate work: the agent searches for an existing issue and comments there, or opens one new backlog issue grouping related findings, never with the approval label. There is no numeric cap; flooding is watched through how many agent-filed issues end as duplicates or not planned.

## Verification

Before the PR ships, a fresh-context `verifier` agent that did not write the change checks four things: every changed hunk traces to an acceptance check, a decision-log row or the PR's `Existing tests changed` line, and a changed assertion missing from that line is flagged; every side effect is in the diff; each acceptance check has evidence that could have failed; and the PR carries the whole scope and `Closes #N`. It reports only what blocks the merge.

Its definition pins the model and effort, since a subagent with neither inherits the session's model and price: Opus at `medium`, and the driver picks model and effort per change from the routing table and passes them on the spawn (Claude Code does; where a harness fixes effort in the agent definition, as Codex and Copilot do, a `high` verify runs as a separate session at `high`, or stays at `medium` with the deviation recorded): Sonnet `medium` for docs, config or XS changes, Opus `high` for security or safety paths (input trust, auth and credentials, secrets and redaction, kill switch and halt, merge and release gates, protected paths); nothing goes above `high`. It runs on the pushed branch before the PR opens, writes its verdict to `.factory/runs/<n>/verdict-<round>.md` with the head SHA it covers on the first line, and never posts or hands back; the run posts the verdict verbatim as a `factory:verdict` PR comment and links the verdicts in the PR body. The merge gate needs a passing verdict on the PR head, or on a head whose only later commits are default-branch merges with no conflict resolution. After a pass, a comment-only or doc-only fix needs no new round; any code change needs a scoped round on that delta. A run has at most three rounds in all, scoped rounds included; one that would need a fourth parks with `reason_code: verify_rounds`. A verifier finding counts only when it blocks the merge and says how to show the failure, and a check that is syntax-only or failed to start is not evidence. Where a harness runs no subagent, the verifier runs as a separate session given the same brief (on pi, the `subagent` tool already starts one).

## Models and cost

Each phase runs on the cheapest model that does it well, set explicitly on every spawn because a subagent with no model inherits the session's price: lookups on Haiku at `low`, CI and merge waits as a background poll, clear XS and S units from the plan on Sonnet at `medium` (the driver hands each testable unit of a split plan to a fresh Sonnet worker, integrates and runs the checks), planning, integration and M and larger or unclear work on Opus at `medium` (a spawned agent when the driver runs below Opus: it only routes and checks mechanically), verification as above, escalation per `subagent-orchestration`. The driver may deviate but records each deviation with a reason in the run checklist and in `result.json`; repeated deviations are a signal to change the policy. A run costs its turns times the context each resends, so every phase gets a real check to finish in fewer turns. `result.json` records harness, model, effort, turns and cost where the harness reports them, so runs can be compared. A headless run takes its per-ticket cap from the harness's budget limit where one exists (Claude Code: `--max-budget-usd`, print mode only). The agent-facing table: `ticket-run`'s `references/routing.md`.

## Definition of done

The whole scope is merged in one PR that closes the ticket (no partial PRs, no `Refs`-only PR); the component's deploy finished and its live checks passed, where it has a deploy; the evidence and the result are posted on the ticket.

## Result contract

Each run writes `.factory/runs/<number>/result.json` in the repo's main checkout (not in the worktree, so it outlives it; `.factory/runs/` is git-ignored). It is overwritten by each run on the same ticket. Template: [`plugins/factory/template/result.json`](../plugins/factory/template/result.json).

**Schema versions.** Schema 2 adds the keys `reason_code`, `phases` and `verifier`, the `end_state` value `halted` (written only by a runtime), and one new source for `run_id`: in a run a runtime started, it is the runtime's `FACTORY_RUN_ID`. No other key changed. (The optional `mode` key and `FACTORY_DEV` came later and do not bump the schema.) The skills write schema 2, and a consumer refuses a schema newer than it supports rather than guess, so a schema-1 consumer must be updated to read it: accept `schema: 2` and `end_state: halted`, and ignore or read the added keys.

| Key | Type | Meaning |
|---|---|---|
| `schema` | integer | Contract version, `2` (`1` in older results). |
| `ticket` | string | `<owner>/<repo>#<number>`. |
| `run_id` | string | `FACTORY_RUN_ID` when a runtime started the run (it sets that variable, plus `FACTORY_DEV=1` in dev mode, and claims under it); else the main session's id where the harness exposes one, else `<host>-<number>-<UTC timestamp>`. Also in the claim comment. |
| `end_state` | `done` \| `parked` \| `failed` \| `budget_reached` \| `halted` | `done`: merged, deployed and verified per the definition of done. `parked`: waiting on the owner (a question, the M+ plan, a merge, or three parks). `failed`: could not be finished for a reason the owner must look at. `budget_reached`: a budget cap stopped the run; a pause, not a failure. `halted`: a runtime stopped the run on a halt (kill switch or circuit breaker); written only by the runtime, never by the skills. |
| `reason` | string | Why the run parked or failed; empty when done. |
| `reason_code` | string \| null | Nullable machine-readable `reason` (the specific cause wins over `question` when a park also asks one): `question`, `plan_gate`, `merge_gate`, `grooming`, `verify_rounds`, `live_verify_failed`, `env_blocked`, `budget` or `auth`; `null` when done or none fits. |
| `phases` | array | `{name, started_at, ended_at}` per run step, in order: `gate`, `plan`, `work`, `verify`, `ship`, `deploy`, `record`, only those the run reached. ISO 8601 timestamps; `ended_at` is `null` for a step the run stopped in. |
| `verifier` | object \| null | `{verdict, rounds}`: the verifier's last verdict (`pass` or `fail`) and how many review rounds ran; `null` when the run stopped before verification. |
| `routing` | array (optional) | `{phase, policy_model, policy_effort, model, effort, deviation_reason}` per spawned phase: what `references/routing.md` prescribes next to what ran. `deviation_reason` is required, non-empty, whenever `model` or `effort` differs from the policy's, else `null`. Absent in older results; a consumer that does not know it ignores it. |
| `mode` | string (optional) | `dev` when the run was started with `FACTORY_DEV=1` (a runtime in dev mode, see [dev mode](../plugins/dev-tools/skills/repo-standard/references/dev-mode.md)); absent otherwise, and `dev` is the only value. Absent in older results and in prod runs; a consumer that does not know it ignores it. It does not bump the schema. |
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

**Telemetry.** `sessions` and `plugin_versions` let a run be joined to the harness's OpenTelemetry data by `session.id` and compared across plugin versions, and `phases` lets it be sliced by step. A runtime may also tag a run's telemetry through `OTEL_RESOURCE_ATTRIBUTES` (for example `factory.run_id`, `factory.ticket`, `factory.role`, `factory.phase`); the skills emit nothing themselves.

## Config: `.factory/config.yaml`

Template with placeholders: [`plugins/factory/template/config.yaml`](../plugins/factory/template/config.yaml).

| Key | Required | Meaning |
|---|---|---|
| `version` | yes | Config format, `1`. |
| `forge` | yes | `github`, the only forge implemented. The skills express each operation as an intent (read the timeline, label, comment, search issues, open a PR) mapped to the forge's CLI, so GitLab or Azure DevOps can be added the way `repo-standard` maps them. |
| `approvers` | yes | GitHub logins whose label and comments count as the owner's. |
| `writers` | no | GitHub logins whose marked comments are trusted (see [Comments](#comments)). Default: `approvers`. The login the session itself posts as always counts. Set it to add a runtime's bot or App login; it replaces the default, so list the approvers too. Optional, so the config format stays `1`. |
| `labels` | no | `approval`, `claimed`, `needs_owner`, `needs_grooming`, `quarantine`, `halt`; defaults as in [Labels](#labels). |
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

This slice ships the skills and the contract; no runtime ships here. The contract defines how one plugs in (`FACTORY_RUN_ID` and its claim, the quarantine and halt labels, `factory:notify`, `end_state: halted`), so a runtime can drive the same skills unchanged. Nothing here assumes a host: paths are relative to the repo or worktree, commands are the forge's CLI and `git`, and the contract records which host and runner made each run.
