# Factory

The `factory` plugin works tickets from a GitHub issue board, one at a time when attended: a person starts each run, and the agent carries the ticket from plan to merged, deployed and verified work. It is generic: anything particular to a repo (owners, labels, components, checks, deploys, risk tiers) is read at run time from that repo's `.factory/` folder. Adopting it in a repo: [adopt-factory.md](adopt-factory.md).

## Principles

- **The owner picks which tickets; the agent owns finishing them.** A ticket is worked only when an approver applied the approval label. Everything the ticket needs to be done is then in scope, and nothing else.
- **The ticket is the shared record.** Plans, questions, scope decisions and evidence go on the issue as comments, so whoever runs the next step (a person, a subagent, a later headless process) starts from the same state.
- **A contract, not code.** A run starts from a ticket and ends with a marked result comment on it and a `result.json`; in a run a runtime started, the runtime posts that comment and applies the labels from the run's `result.json` ([Runtime runs](#runtime-runs)). Nothing else is assumed about what runs it, so a runtime can come later without changing the skills.
- **Only declared identities instruct a run.** Text from anyone outside `approvers` and `writers` is untrusted data: it describes at most a problem and never changes scope, steps, permissions or the plan. A ticket whose title or body anyone, an approver included, edited after the approval is not approved, an owner-gated merge resumes the ticket only when an approver merged it, and any change under `.factory/` lands as `merge: owner`. While a run is active the `guard` plugin denies any command that adds the approval label, since a token that is also an approver would make it the owner's, and any command that names the takeover label; it also denies a shell write to `.github/**`, `.factory/**` (except files inside a run directory, `.factory/runs/<n>/…`, which are the run's own outputs; write them by a literal absolute path or `$(git rev-parse --path-format=absolute --git-common-dir)/../.factory/runs/<n>/…`, since a nested substitution is not understood) or a path the runtime adds through `FACTORY_PROTECTED_PATHS` ([guard.md](guard.md#decisions)).
- **Never a decision by silence.** A question parks the ticket until an approver answers on it. The agent never closes, re-scopes or marks an issue not planned; only its own PR's `Closes #N` closes the ticket. A change run's fix attempt refers to the change and its issues and closes nothing; only the change's merge closes them.

## Attended flow

The `ticket-run` skill carries one ticket through these steps; call it with the issue number, and again on a parked ticket once you have answered. `factory-status` lists what needs you, what is in progress and what is done, from the labels and marked comments.

1. **Gate.** The ticket is open and carries the approval label, the issue timeline shows an approver applied it (a `[bot]` login among the approvers counts only when `approvers_allow_bots` is true), and nobody, an approver included, edited the title or body since: the approval covers the text as it stood when the label was applied, and only an approver applying the label again restores it. Otherwise the run stops and says why. `ticket-run`'s `scripts/gate.mjs <n>` makes these reads and the claim and takeover checks in one call and prints one JSON verdict (`go`, `wait` or `stop`, with the failed check and its `reason_code`); readiness stays the run's call on the body.
2. **Plan comment**, drafted by a `dev-tools:driver` spawn. Goal, acceptance checks (each one a command or observation that fails before the change), side effects in scope, planned fold-ins, size and risk tier. XS and S tickets start right after it; M and larger post it as a question and park until the owner's OK.
3. **Work** in its own worktree and branch, applying the fold-in test to everything found on the way and logging the calls the plan does not already cover in the decision log.
4. **Questions** go on the ticket, one per comment, and park the ticket (below).
5. **Verify** with a fresh-context verifier that is never the author.
6. **Ship and land**: one PR with `Closes #N` and the decision log as `## Scope`; merged per the risk tier (auto-merge or the owner).
7. **Deploy and live-verify** where the component has a deploy, then post the evidence and the result.

## Labels

| Label (config key) | Default | Set by | Meaning |
|---|---|---|---|
| `labels.approval` | `agent-ok` | an approver, only | The ticket may be worked. The agent never adds or removes it (in a runtime run the guard denies any command that names it). |
| `labels.claimed` | `factory-claimed` | the agent; in a runtime run, the runtime | A run holds the ticket (see [Claims](#claims)). Removed when the run ends. |
| `labels.needs_owner` | `needs-owner` | the agent; in a runtime run, the runtime | A question waits on the owner. Removed when the run resumes on an answer. |
| `labels.needs_grooming` | `needs-grooming` | the agent; in a runtime run, the runtime | Three parks: the ticket is under-specified and goes back to the owner for refinement. |
| `labels.quarantine` | `factory-quarantine` | a runtime | Repeated failed or stalled runs: a runtime stops picking the ticket until an approver removes the label. |
| `labels.halt` | `factory-halt` | an approver, an alert or a runtime | Set on an open issue (the halt issue): a runtime starts no run in the repo while any open issue carries it. |
| `labels.takeover` | `factory-takeover` | an approver, only | Hand the ticket from a runtime to an attended run (see [Takeover](#takeover)). Removed only by the attended run that took the ticket over, once its claim is posted; in a runtime run the guard denies any command that names it. |

When the repo has a project board (`board` in the config), the agent also sets its status field: in progress while working, blocked while parked.

## Comments

Every comment the agent posts starts with two hidden lines: the marker (config `marker`, default `<!-- factory -->`) and a kind tag. The marker is what tells an agent comment from the owner's when both are posted under the same account.

| Kind tag | Posted | Body |
|---|---|---|
| `<!-- factory:claim -->` | when a run claims the ticket | Host, run id, runner (`attended`, `headless`, `runtime`). A runtime may add the approval it pinned (`approved by`, `approved at`, `revision`); these are informational, never read back to decide anything. |
| `<!-- factory:plan -->` | once at the start, edited in place | Goal, acceptance checks, side effects in scope, planned fold-ins, size, risk tier. M and larger end by asking for the owner's OK. |
| `<!-- factory:question Q<n> -->` | per question | One question, the options, a recommendation with its reason, and what is done so far. |
| `<!-- factory:log -->` | once, edited in place | The decision log: one row per call the plan does not already cover. Mirrored as `## Scope` in the PR. A runtime handing the ticket over adds a `branch: <name>` line naming the WIP branch ([Takeover](#takeover)). |
| `<!-- factory:verdict <round> -->` | on the PR, once per verifier round | The verifier's verdict, verbatim as it returned it (the run's verdict file); its first line names the head SHA it covers. |
| `<!-- factory:result <end_state> -->` | at the end of each run (in a runtime run, `result.json` only) | End state, PR, evidence links, follow-ups. The same facts as `result.json`. |
| `<!-- factory:notify <kind> -->` | by a runtime only, when it must reach an approver | An @-mention of the approvers and one line on why, `<kind>` naming the event (for example `question`, `halt`, `quarantine`, `budget`). It carries the marker, so it is never read as an answer. |

Posting is idempotent: before posting, the agent looks for its own comment of the same kind and edits it instead; a write counts only once the forge's API confirms it, and an unconfirmed one is recorded as `maybe_posted` and checked by its marker before any retry. Statuses in a comment are read from their live source just before posting, and links are copied from the API's URL fields.

**Dev mode.** Under `FACTORY_DEV=1` (set by a runtime started in dev mode), every comment the run posts ends with a last field line `mode: dev`, so a dev run's output never passes as prod; every comment parser tolerates it as one more field line. See the [dev-mode rule](../plugins/dev-tools/skills/repo-standard/references/dev-mode.md).

**Authors.** A marked comment counts only when a writer wrote it: a login in `writers` (config), or in `approvers` when `writers` is unset, or the login the reading session itself posts as. Every other marked comment is ignored as if absent, wherever one is read (the skills, the `verifier`, `factory-status`, a runtime): it claims nothing, asks or answers nothing, records no plan, log or result, and is never edited in place. The marker alone proves nothing, since anyone who can comment on the repo can type it. A runtime that posts under its own login (a bot or GitHub App) must be listed in `writers`, or a session under the owner's login ignores its claims and notices; a repo whose runtime already posts that way adds `writers` when it takes factory 0.6.0, or its runtime-started runs stop at the gate. That stop names the cause: when no trusted claim carries the run's `FACTORY_RUN_ID`, the run stops with `reason_code: auth`, writes `result.json` and acts on nothing an untrusted claim says. It names the login to add, exactly as the REST API reports it, only when that login applied the claim label (its last `labeled` actor on the timeline) and posted exactly one claim with that run id; otherwise it names no one and says to add the runtime's login. A run id can be copied by anyone who can comment, a label event cannot. Anyone who can label can still be named (someone with triage access who re-applies the claim label and posts one copied claim), so check that a named login really is the runtime's before adding it to `writers`. Logins are compared as the REST API reports them (`user.login`, an App as `<slug>[bot]`), ignoring case.

**Answers.** The answer to an open question is the newest comment after it that an approver wrote and that does not carry the marker (so a `factory:notify` mention never counts). Comments by any other account are ignored. Logins are compared ignoring case, as for writers, and an unset or empty `marker` means the default. A run resumes only on such an answer; with none, the ticket stays parked.

**Parks.** A question sets `needs-owner` (and the board's blocked status) and ends the run; in a runtime run the run still sets the board status itself (the board is not a label), and the runtime applies the label from the result. After the third question on one ticket, the agent sets `needs-grooming` and stops; it leaves the approval label alone. A ticket with `needs-grooming` is not worked (the skill's gate and a runtime's poller both skip it). Removing `needs-grooming` re-admits the ticket; to re-approve it after grooming instead, the owner removes the approval label and applies it again.

## Runtime runs

When a runtime started the run (`FACTORY_RUN_ID` set), the runtime owns the ticket's labels and its result comment (the board status stays the run's: blocked on a park, in progress on resume, when `board` is configured): it reads the run's `result.json`, posts the `factory:result` comment from it and applies the labels it implies (the claim's release, `needs-owner` for a park, `needs-grooming` for the third). The run writes `result.json` with `write-result.mjs` and stops: it posts no result comment and adds or removes no label, so `posts` lists no result comment. Everything else is the same as attended: the run still edits the runtime's claim comment, posts its plan, log and question comments and opens its PR. A runtime that does not post the result or apply those labels does not meet the contract.

## Claims

A claim is visible on the forge, never only a local lock, so runs on different hosts never take the same ticket. A run claims a ticket by adding the claim label and posting a `factory:claim` comment with its host and run id (a run a runtime started finds both already there, under the run id in `FACTORY_RUN_ID`, and edits that comment instead of posting a second), and releases it by removing the label when it ends, in any end state (a runtime releases its own claim). A run that finds the label with another run's claim stops; only a claim comment by a writer (see [Authors](#comments)) is a claim. A claim left by a run that died is cleared by the owner, by removing the label. A runtime on several hosts uses the same protocol; the race between two claims at the same moment is its to settle (for example by re-reading the newest claim comment after posting).

A runtime may open a ticket's dependent work as a stack of PRs; the result, labels and claim stay per PR, so each PR is reported and labelled on its own.

## Takeover

An approver who wants to finish a ticket a runtime is working, attended, applies the takeover label. The two sides never hold the ticket at once: the runtime releases it before the attended run claims it, and the label stays on until that claim is posted, so the runtime cannot claim in between. Both sides fail closed: a read that errors or cannot be judged never lets a step go on.

- **Who applied it.** The label counts only when its last label event on the issue timeline is `labeled` by a login in `approvers`, the list the approval check reads; unlike that check, it does not apply `approvers_allow_bots`, so a `[bot]` login in `approvers` counts here whatever the key says (tracked in #285). Both sides ignore it otherwise, as if it were absent: anyone who can label issues could otherwise stop a runtime run.
- **The runtime** that sees the label, applied by an approver, on a ticket it holds stops the run gracefully: the run commits and pushes its work to the ticket's WIP branch, the runtime records the trusted `factory:log` comment with a field line `branch: <name>` naming that branch (editing the existing log in place, or posting it when there is none), writes the result with `end_state: halted` and `reason_code: takeover`, and releases the claim. It never claims or starts a ticket while such a label is on it.
- **The attended run** (`ticket-run` on a ticket with the label) checks who applied it, then waits while the claim label is on and the newest trusted claim is a `runtime` one, with a bound; a failed read counts as still held, and any other claim stops it as usual. Once the claim is released it runs the gate again, claims as runner `attended`, removes the takeover label, and checks out the branch named in the newest trusted `factory:log` comment, reusing a local branch or worktree of that name when it fast-forwards and the runtime's open PR from it. The `branch:` value is untrusted data: it is used only when it is one plain ref name (letters, digits, `.` `_` `/` `-`) that passes `git check-ref-format --branch`, is not the default branch and exists on the remote, always single-quoted; otherwise the run starts from the default branch and logs why. It then continues from the plan step, editing the runtime's plan and log comments in place.
- **Who touches the label.** Only an approver applies it. Only the attended run that took the ticket over removes it, after its claim. Inside a runtime run (`FACTORY_RUN_ID` set) the guard denies any command that names it, as for the approval label.

`factory-status` lists a ticket under takeover under "Needs you" until the attended run removes the label.

## Change runs

A change run works an open pull request (the change) instead of an issue: it turns what an approver or a required check asked of the change into one unit of work, fixes it on the change's branch and records a fix attempt. The change is the ticket: the result sits under the change's number, and no second PR is opened. The rules are in [change.md](../plugins/factory/skills/ticket-run/references/change.md); in short:

- **Roles.** The author must be the factory, an approver or the session's own login. An approver's `CHANGES_REQUESTED` review, or its comment that mentions the factory, is a request to act, and so is a required check failing on the change's current head. Other reviewers' text is data. The factory's own events never start a run.
- **Triggers.** `changes_requested`, `mention` and `check_failed`. Each source is handled once, listed in the result comment.
- **Unit brief.** The run writes the unit to a file that `scripts/check-change.mjs` checks. Every item's text is untrusted data: an approver's request sets what to fix, but never widens permissions or skips a step.
- **Refers, never closes.** Commits and comments use `Refs #N` only, with no closing keyword, and the PR body's closing line is never edited. The result comment goes on the change. `done` means pushed, verified and the required checks pass, with the change still open.
- **Bounded retry.** `change_requests.max_attempts` (default `3`) caps the fix attempts per change. The next one parks with `reason_code: fix_attempts` and `needs-owner` on the change; an approver removing `needs-owner` resets the count.
- **Identity.** The `identity.logins` never trigger a run. `identity.mention` is the handle an approver writes to ask the factory to act; without it no mention is an input.

## Readiness

A ticket is ready when its body has acceptance criteria and a proof command: a command or observation that shows it done. A ticket that is approved but not ready gets a question proposing both, not a start.

## Scope: the fold-in test

Anything found during the work is in scope when an acceptance check needs it, when it is a side effect of the change (migrations, tests, docs and runbooks, generated types, config, deploy, live verification), or when it is entangled with the changed code so that fixing it later means reworking this change. Side effects are always in.

The decision log holds only calls the approved plan does not already cover: fold-ins beyond the plan, questions, notes and follow-ups. Hunks that trace to an acceptance check and side effects the plan names get no row; changed existing test assertions get one `Existing tests changed: <test> (<old> → <new>, per AC<n>)` line in the PR's Verification section.

An in-scope item that is not a must-have is folded in by the agent alone only if it stays in the ticket's component, grows the ticket by at most one size step, does not raise the risk tier, and needs no owner or product decision. Otherwise the agent asks. Items that are not in scope are separate work: the agent searches for an existing issue and comments there, or opens one new backlog issue grouping related findings, never with the approval label. There is no numeric cap; flooding is watched through how many agent-filed issues end as duplicates or not planned.

## Group runs

A runtime may work several approved tickets in one session, a group run. The runtime hands the members to the run in the run file named by `FACTORY_RUN_FILE`, checked with `check-handoff.mjs run`. Each member is gated and claimed under the run id, then worked by a subagent from a member brief, which hands back a member result the runtime checks with `check-handoff.mjs`. A malformed handoff parks only that member (`reason_code: handoff`). A released member goes back to the queue unchanged: its claim is released and it gets no result comment, no label and no other comment. A group with no done member ships nothing: no PR, and `result.json` says why. Otherwise one PR carries the done members, with `Closes #N` per done member and `Refs #N` per parked or released one. The result lists the members in `tasks` (schema 3). Formats: [group.md](../plugins/factory/skills/ticket-run/references/group.md) and [result.md](../plugins/factory/skills/ticket-run/references/result.md). An attended run works one ticket and writes no `tasks`.

## Verification

Before the PR ships, a fresh-context `verifier` agent that did not write the change, the reviewer for factory tickets, checks five things: the change is correct (behaviour, edge cases, callers, security and data-loss risks, whether or not an acceptance check covers them); every changed hunk traces to an acceptance check, a decision-log row or the PR's `Existing tests changed` line, and a changed assertion missing from that line is flagged; every side effect is in the diff; each acceptance check has evidence that could have failed; and the PR carries the whole scope and `Closes #N`.

Its model and effort per change (Opus at `medium` for code, Sonnet for docs, config or XS changes, `high` effort for security or safety paths) are in `ticket-run`'s `references/routing.md`. It runs on the pushed branch before the PR opens and returns its verdict as text, with the head SHA it covers on the first line; it never writes a file or posts, so a denied command cannot lose the verdict. The run waits for it in the same turn, writes the verdict verbatim to `.factory/runs/<n>/verdict-<round>.md`, posts it verbatim as a `factory:verdict` PR comment and links the verdicts in the PR body. The merge gate needs a passing verdict on the PR head; commits after it go through the `land` skill's post-approval check, and a code change among them also needs its scoped round. After a pass, a comment-only or doc-only fix needs no new round; any code change needs a scoped round on that delta. A run has at most three rounds in all, scoped rounds included, one more than a general review because that scoped round counts; one that would need a fourth parks with `reason_code: verify_rounds`. Findings are `Blocker`, `Major` or `Minor`; only a `Blocker` or `Major` fails the verdict, and a finding says how to show the failure. A check that is syntax-only or failed to start is not evidence. Where a harness runs no subagent, the verifier runs as a separate session given the same brief, in the foreground, its last message the verdict (on pi, the `subagent` tool already starts one). Every subagent brief in a run carries the command-form rule (one plain command per shell call, no `cd` or `echo` chains), since a subagent does not know the skill's gotchas ([routing.md](../plugins/factory/skills/ticket-run/references/routing.md#waiting-and-briefs)).

## Models and cost

Each phase runs on the cheapest model that does it well, and every judgement call on a ticket (the plan, size and risk tier, scope and fold-in calls, integration, fixes for verifier findings) is made at the driver tier by a `dev-tools:driver` spawn, whatever the session's model; the session running the ticket only routes, posts what the driver writes and checks mechanically. The routing itself (which agent takes which work, spawn rules, escalation) is the `dev-tools` plugin's `subagent-orchestration`; the run adds a fixed table per phase, the agent-facing copy in `ticket-run`'s `references/routing.md`. The model pin holds where the harness lets an agent pin it (Claude Code; Copilot CLI through user settings); in Codex, opencode and pi agents run on the session's model ([compatibility.md](compatibility.md)). The run may deviate but records each deviation with a reason in the run checklist and in `result.json`; repeated deviations are a signal to change the policy. `result.json` records harness, model, effort, turns and cost where the harness reports them, so runs can be compared. A headless run takes its per-ticket cap from the harness's budget limit where one exists (Claude Code: `--max-budget-usd`, print mode only).

## Definition of done

The whole scope is merged in one PR that closes the ticket (no partial PRs, no `Refs`-only PR); the component's deploy finished and its live checks passed, where it has a deploy; the evidence and the result are posted on the ticket.

## Result contract

Each run writes `.factory/runs/<number>/result.json` in the repo's main checkout (not in the worktree, so it outlives it; `.factory/runs/` is git-ignored). It is overwritten by each run on the same ticket. Template: [`plugins/factory/template/result.json`](../plugins/factory/template/result.json).

**Writer and check.** The skills write the file with `ticket-run`'s `scripts/write-result.mjs`, never by hand (a hand-written `ticket` came out as a bare number in two of two parked runs, [#306](https://github.com/giocaizzi/harness/issues/306)). The run gives it only its judgment fields, as a JSON file or on stdin; it fills `schema`, `ticket` (`FACTORY_TICKET`, else `--ticket`, else `FACTORY_ATTENDED_TICKET`; a `--ticket` that differs from `FACTORY_TICKET` is refused), `run_id` (in the order `result.md` gives for it, `--run-id` being the id the run's claim carries when neither variable gives one), `mode`, `host.name`, `host.os`, `host.runner` unless the input gives one (`runtime` when `FACTORY_RUN_ID` is set, else `attended`; an input `runtime` without that variable, or any other runner with it, is refused), `finished_at`, and a last `record` phase's `null` `ended_at`; it writes schema 3 when the input has `tasks`. It refuses an input that holds a key it fills or a key outside the contract, `end_state: halted` or `reason_code: takeover`, checks the whole result, and writes it to the main checkout through a temporary file and a rename, or writes nothing: exit 0 written, 1 invalid (every error on stderr), 2 usage or environment. `--post <kind>=<url>` appends a posted comment to the written file, or marks an entry already listed with that URL `posted`, and checks it again, keeping `finished_at`. `scripts/check-result.mjs <result.json>` runs the same checks alone, on any result, a runtime's included: `schema` 2 (3 with `tasks`), a non-empty `run_id` equal to `FACTORY_RUN_ID` when that is set, `end_state` and `reason_code` from the lists in `result.md` (`halted` and `takeover` included), `reason` a string, `ticket` the string form and equal to `FACTORY_TICKET` when set, `finished_at` and `phases`, `routing` and `mode`, and, when `tasks` is present, `tasks` and the group rules; a missing file or broken JSON is one error line, and an echoed value is cut to 200 characters and a report to 50 lines. It imports only Node built-ins, so a hook can reuse it: the `guard` plugin's stop hook runs a copy of it as the result gate, which holds a runtime's run at most twice while this file is missing, invalid or another run's, and an attended run only while a file carrying its own `run_id` is invalid ([guard.md](guard.md#decisions)); a separate verifier session runs with `GUARD_RESULT_GATE=off`. A runtime whose permission profile limits a run's commands must allow `node */skills/ticket-run/scripts/write-result.mjs *`, or its runs cannot record.

**Schema versions.** Schema 2 adds the keys `reason_code`, `phases` and `verifier`, the `end_state` value `halted` (written only by a runtime), and one new source for `run_id`: in a run a runtime started, it is the runtime's `FACTORY_RUN_ID`. No other key changed. (The optional `mode` key and `FACTORY_DEV` came later and do not bump the schema.) Schema 3 adds only `tasks`, written only for a group run: a single-ticket result stays schema 2, so a schema-2 consumer reads every single-ticket result as before and refuses a group's; the `handoff` reason code appears only in `tasks`. The skills write schema 2 (3 for a group run), and a consumer refuses a schema newer than it supports rather than guess, so a schema-1 consumer must be updated to read it: accept `schema: 2` and `end_state: halted`, and ignore or read the added keys.

The keys, their types and meaning: [`result.md`](../plugins/factory/skills/ticket-run/references/result.md) in `ticket-run`, the single source of truth, which the skill reads while it writes a result.

**Telemetry.** `sessions` and `plugin_versions` let a run be joined to the harness's OpenTelemetry data by `session.id` and compared across plugin versions, and `phases` lets it be sliced by step. A runtime tags each run's telemetry through `OTEL_RESOURCE_ATTRIBUTES` and its `GUARD_OTEL_RESOURCE_ATTRIBUTES` copy: `factory.run_id`, `factory.ticket` (`<owner>/<repo>#<number>`), `factory.role`, `factory.phase` and `factory.mode=unattended`. An attended session carries the same keys when it is started through the launcher ([below](#attended-telemetry)); the skills emit nothing themselves.

### Attended telemetry

Resource attributes are fixed when a harness process starts, and an attended run begins inside a session the person opened, so the session must be started already tagged. `ticket-run`'s launcher does it, one session per ticket:

```bash
bash plugins/factory/skills/ticket-run/scripts/attended.sh acme/app#12 claude                                       # macOS, Linux
pwsh -File plugins/factory/skills/ticket-run/scripts/attended.ps1 acme/app#12 copilot                            # PowerShell 7
powershell -ExecutionPolicy Bypass -File plugins/factory/skills/ticket-run/scripts/attended.ps1 acme/app#12 copilot  # Windows PowerShell 5.1
```

These paths are relative to a checkout of this repo, the simplest place to run it from. Inside an installed copy of the `factory` plugin the script sits at `skills/ticket-run/scripts/` under the plugin's directory, which each harness keeps in its own plugin cache (Claude Code: `~/.claude/plugins/cache/<marketplace>/factory/<version>/`); opencode's install copies it to `~/.config/opencode/skills/ticket-run/scripts/`, and pi keeps the whole repo, so the checkout path applies under its package directory. Then ask the session to work the ticket. It sets `FACTORY_ATTENDED_RUN_ID` (`<host>-<number>-<UTC timestamp>`) and `FACTORY_ATTENDED_TICKET`, appends `factory.run_id` (that id), `factory.ticket`, `factory.role=main` and `factory.mode=attended` to `OTEL_RESOURCE_ATTRIBUTES` and `GUARD_OTEL_RESOURCE_ATTRIBUTES` (replacing any pair whose key starts with `factory.`, matched case-sensitively as OTel keys are, and keeping the rest, trimmed of surrounding spaces), and runs the harness command, passing its exit code through. `ticket-run` writes that id as `run_id` in `result.json` and its claim, so the run's telemetry and its result join on it. It refuses to start when `FACTORY_RUN_ID` is set, since that marks a runtime's run, and a variable separate from `FACTORY_RUN_ID` keeps the gate from treating the run as one.

Two keys differ from a runtime's: `factory.phase` is absent, since a phase changes while the process's attributes cannot (slice by `phases` in `result.json` instead), and `factory.role` is `main` for the whole session, native subagents such as the verifier included, since they share its environment (`sessions` in `result.json` tells them apart). A session started without the launcher is untagged and its `run_id` is the session id, as before.

Per harness ([compatibility.md](compatibility.md)):

| Harness | Its own telemetry | `guard` records |
|---|---|---|
| Claude Code | tagged: it reads `OTEL_RESOURCE_ATTRIBUTES` at start | tagged, from the `GUARD_OTEL_*` copy (hooks get no `OTEL_*`) |
| Copilot CLI | tagged: it reads `OTEL_RESOURCE_ATTRIBUTES` at start | tagged, from the `GUARD_OTEL_*` copy |
| VS Code | not confirmed that Copilot Chat's export reads it ([#291](https://github.com/giocaizzi/harness/issues/291)); a VS Code already running ignores a new launch's environment | tagged only when the launcher started VS Code's first window |
| Codex | tagged: its OTel resource uses the SDK's default detectors, which read `OTEL_RESOURCE_ATTRIBUTES` | tagged |
| opencode | none of its own; the `guard` plugin's `api_request` is tagged | tagged |
| pi | none of its own; the `guard` extension's `api_request` is tagged | tagged |

## Config: `.factory/config.yaml`

Template with placeholders: [`plugins/factory/template/config.yaml`](../plugins/factory/template/config.yaml).

| Key | Required | Meaning |
|---|---|---|
| `version` | yes | Config format, `1`. |
| `forge` | yes | `github`, the only forge implemented. The skills express each operation as an intent (read the timeline, label, comment, search issues, open a PR) mapped to the forge's CLI, so GitLab or Azure DevOps can be added the way `repo-standard` maps them. |
| `approvers` | yes | GitHub logins whose label and comments count as the owner's. |
| `approvers_allow_bots` | no | `true` lets an approval label applied by a `[bot]` login in `approvers` (a GitHub App, `<slug>[bot]`) count; default `false`, so a login ending in `[bot]` cannot approve a ticket. Only that suffix is refused: a machine-user account, or an App acting through a user-to-server token (whose events carry the user's login), still counts as the approver it is listed as. Optional, so the config format stays `1`. |
| `writers` | no | GitHub logins whose marked comments are trusted (see [Comments](#comments)). Default: `approvers`. The login the session itself posts as always counts. Set it to add a runtime's bot or App login, exactly as the REST API reports it (`<slug>[bot]` for an App, never the bare slug, which can be another account); it replaces the default, so list the approvers too. Optional, so the config format stays `1`. |
| `identity` | no | Who the factory is on the forge, for [change runs](#change-runs). `logins`: what it posts, pushes and reviews as; they never trigger a run, and each must also be in `writers`. `mention`: the handle an approver writes on a change to ask the factory to act. Optional, so the config format stays `1`. |
| `change_requests` | no | `max_attempts`: the fix attempts per change, default `3` ([change runs](#change-runs)). Optional, so the config format stays `1`. |
| `labels` | no | `approval`, `claimed`, `needs_owner`, `needs_grooming`, `quarantine`, `halt`, `takeover`; defaults as in [Labels](#labels). |
| `marker` | no | Hidden first line of every agent comment; default `<!-- factory -->`. |
| `size_label_prefix` | no | Label prefix that carries the ticket's size (`XS`, `S`, `M`, `L`, `XL`). Without it, the plan estimates the size. |
| `board` | no | `owner`, `project` (number), `status_field` and the `status` option names for `in_progress`, `blocked` and `backlog`. Omit when there is no board. |
| `components` | yes | Per component: `paths` (globs), `checks` (commands that prove a change), and optional `deploy` with `wait`, `verify` (commands; `$SHA` is the merge commit) and `rollback`. |
| `notify` | no | How a runtime tells the owner a question waits: exactly one of `topic` (a name, never a URL, that the runtime's host config maps to a keyring reference for the destination) or `command` (reads the message on stdin). A `url`, or any other key, is flagged, and so is a block with both `topic` and `command` ([Notifications](#notifications)). A `command` runs on the runtime's host under the same trust as the `checks` and `deploy` commands (whether it should stay a repo key: #288). Reminders are host settings, not repo keys ([Notifications](#notifications)). Unused by attended runs. |
| `telemetry` | no | `resource_attributes` a runtime sets on a run's telemetry. The OTLP endpoint comes from the environment (`OTEL_EXPORTER_OTLP_ENDPOINT`), never from this file. |
| `secrets` | no | Name to `{provider, ref}`: secrets the deploy and verify commands need, by reference through the `secrets-handling` providers, never values. |
| `risk` | yes | Tiers lowest first, each with `tier`, `paths` (globs) and `merge` (`auto` or `owner`). A change takes the highest tier any path matches; unmatched paths are `medium`. |

## Notifications

A repo names where its notices go, never how to reach it: `notify.topic` is a plain name (for example `factory`), and the runtime's host config maps it to a keyring reference holding the real destination, so no URL, token or address enters the repo. A repo sets one of `topic` or `command`, never both.

**Flagged** means the `notify` block breaks the contract, so a runtime must treat the repo's `notify` config as invalid and send no notice through it. These are flagged:

- A `notify.url` in repo config: it gets no message.
- Any key other than `topic` and `command`, the reminder keys included.
- A block that sets both `topic` and `command`.

Reminders belong to the host, so one owner gets the same cadence across repos. In the runtime's host config, not in `.factory/config.yaml`:

| Host key | Meaning |
|---|---|
| `notify.remind_after` | How long a question stays unanswered before the runtime notifies again. |
| `notify.remind_max` | How many reminders it sends at most for one question; after the last, the ticket stays parked and nothing more is sent. |

## Layers and what is not built yet

The factory has three layers:

- **Skills:** the method (`ticket-run`, `factory-status`, the `verifier`), portable across harnesses.
- **Contract:** the ticket, its labels, the marked comments and `result.json`.
- **Runtime:** the execution layer that hosts runs on one or more hosts: polling and scheduling, claims, supervision, harness adapters, identity and tokens, permission and sandbox profiles, budgets, telemetry tagging, notifications and self-healing. Unattended overnight work ("drain") is one runtime policy.

This slice ships the skills and the contract; no runtime ships here. The contract defines how one plugs in (`FACTORY_RUN_ID` and its claim, the quarantine, halt and takeover labels, `factory:notify`, `end_state: halted`, and for a change run the `change` result key and `reason_code: fix_attempts`), so a runtime can drive the same skills unchanged. Nothing here assumes a host: paths are relative to the repo or worktree, commands are the forge's CLI and `git`, and the contract records which host and runner made each run.
