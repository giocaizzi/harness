# Usage guide

Every feature this marketplace ships, how to call it and how to tune it. New here: [quickstart.md](quickstart.md). Install and update: [install.md](install.md). What each harness supports and why: [compatibility.md](compatibility.md). Internals of each plugin: [guard.md](guard.md), [hud.md](hud.md), [sounds.md](sounds.md).

## How you call things

There are four kinds of feature, and you call each one differently:

| Kind | Plugins | How it starts |
|---|---|---|
| Skills | `dev-tools`, `python`, `go`, `javascript`, `api` | **By itself** when the request matches its description ("open a PR" loads `ship`), or **by you** with its slash command. |
| Agents | `dev-tools` (`scout`, `escalate`), `api` (`api-reviewer`) | **Ask for one by name** ("use scout to ..."); the main agent delegates to it. |
| Hooks | `guard`, `sounds` | **Never called.** They run on their own around tool calls, prompts and turns. |
| Display | `hud` | **Always on**, plus a few slash commands for panes. |

Calling a skill yourself, per harness (full table with agents and the rest: [compatibility.md](compatibility.md#user-level-setup)):

| Claude Code | Copilot CLI | VS Code | Codex | opencode | pi |
|---|---|---|---|---|---|
| `/dev-tools:ship` | `/ship` | ask in words | `$dev-tools:ship` | `/ship` | `/skill:ship` |

Anything after the name is its argument: `/dev-tools:wt 42`, `$dev-tools:land 128`, `/skill:ship draft`. Asking in words ("land PR 128") works everywhere.

## Skills

### Task workflow (`dev-tools`)

The skills that carry one change from start to merge, in order:

| Step | Skill | Argument | What it does |
|---|---|---|---|
| 1. Start | `wt` | issue number or slug | Creates `.claude/worktrees/<slug>` on a `<type>/<slug>` branch from the fresh default branch; checks quota and stale worktrees first. |
| 2. Ship | `ship` | `draft` (optional) | Splits the diff into small Conventional Commits, pushes, opens a PR if none exists. |
| 3. Fix | `pr-fix` | PR number (optional) | Reads unresolved review threads and failing CI, fixes them, commits and pushes. |
| 4. Land | `land` | PR number (optional) | Waits for CI, fixes trivial failures, merges through auto-merge or the queue (a direct squash merge after every check passed where auto-merge is unavailable, never `--admin`), syncs main, removes the branch and worktree, then verifies the change where it lands (deploy and health, rendered dotfiles, installed plugin version, release tag). Also answers `/verify`. |
| Any time | `docs-sync` | path (optional) | Updates the docs, runbooks, README and `AGENTS.md` that the current diff made stale. |
| Any time | `standup` | scope (optional) | Terse status: done (merged PRs with SHAs, releases, deploys), in flight (open PRs and CI, running agents), what waits on you, leftovers (worktrees, branches, temp files). |

Example session:

```text
/dev-tools:wt 42
add retry with backoff to the uploader
/dev-tools:docs-sync
/dev-tools:ship
/dev-tools:land
```

### Reference skills (`dev-tools`)

These load by themselves when the work touches their subject; call them by name to apply one on purpose.

| Skill | Loads when you ... |
|---|---|
| `conventional-commits` | write a commit message or PR title, rewrite history |
| `semver` | decide whether a change is breaking, plan a release, review a version bump |
| `release-please` | release, bump versions, edit release-please config |
| `github-workflow` | open, split, stack or merge PRs; set up rulesets or merge-gating CI |
| `repo-standard` | set up or audit a repo (CI, settings, publishing) on GitHub, GitLab or Azure DevOps |
| `secrets-handling` | touch credentials, tokens, `.env`, a keyring or a vault (Bitwarden details in its `references/bitwarden.md`) |
| `host-hygiene` | run heavy builds, emulators, full test suites or parallel agents; the host is slow |
| `subagent-orchestration` | spawn subagents, pick a model or effort, coordinate with other running sessions |
| `unattended-runs` | start an overnight, headless or auto-approve run |

`host-hygiene` also ships scripts the agent runs for you: `heavy.sh` (one heavy command at a time), `lease.sh` (exclusive use of a device or port), `register-service.sh`, `memory-lint.mjs` (report-only memory lint), `sweep-stale.sh` (stale worktrees, `--branches` for stale branches), with `.ps1` twins for Windows.

### Language skills

| Plugin | Skill | Loads when you ... |
|---|---|---|
| `python` | `python-development` | write, review or scaffold Python (uv, ruff, mypy, typing, layout) |
| `python` | `python-testing` | write or review pytest tests |
| `go` | `go-development` | write, review or scaffold Go (go.mod and `go tool` deps, golangci-lint v2, errors, context, slog, concurrency, process supervision, goreleaser) |
| `go` | `go-testing` | write or review Go tests (table tests, fakes, golden files, synctest, fuzzing, benchmarks, race detector) |
| `javascript` | `javascript-typescript` | write or review JS/TS or Node |
| `javascript` | `react` | write or review React 19+ |
| `javascript` | `nextjs` | work in a Next.js (App Router) project |
| `javascript` | `atomic-design` | structure a UI kit or component folders, or set up architecture lint |
| `api` | `fastapi` | write FastAPI routes, schemas, dependencies, tests |
| `api` | `sqlalchemy` | define models, write queries, manage sessions and migrations |
| `api` | `ddd` | design bounded contexts, aggregates, ports and adapters |

### Ticket runs (`factory`)

For a repo adopted per [adopt-factory.md](adopt-factory.md): you approve a ticket by labelling it `agent-ok`, the agent works it, and everything it decides or asks lands on the ticket ([factory.md](factory.md)).

| Skill | Argument | What it does |
|---|---|---|
| `ticket-run` | issue number | Checks you applied the approval label, posts a plan, works the ticket in its own worktree deciding scope with the fold-in test, asks questions on the ticket and parks until you answer there, runs the `verifier`, ships one PR that closes the ticket, merges by risk tier, deploys and live-verifies, and records the result. Run it again on a parked ticket after you answer. |
| `factory-status` | days of done tickets (default 7) | One screen from GitHub labels and the marked comments: halted and quarantined tickets, tickets that need you with their open question, in progress with PR and checks, parked for grooming, approved and not started, recently done. Read-only. |

## Agents

| Agent | Plugin | Ask for it when | Model |
|---|---|---|---|
| `scout` | `dev-tools` | you need something found or read: code, logs, test output. Read-only; answers with `file:line` evidence. | cheapest (Claude: Haiku, `low`) |
| `escalate` | `dev-tools` | the normal model failed twice on the same bug or design question | strongest (Claude: Fable) |
| `api-reviewer` | `api` | you want an API security review: vulnerabilities, RBAC leaks, compliance | driver (Claude: Opus, `medium`) |
| `verifier` | `factory` | a ticket's change is ready to ship and needs a gate that did not write it ([factory.md](factory.md#verification)) | driver (Claude: Opus, `high`; `medium` or `low` for trivial changes) |

How to call one: say it ("use scout to list every place we read `GUARD_` env vars"). Per harness: Claude Code `/agents` lists them; Copilot CLI `/agent` picks one; opencode `@scout`; Codex and pi by asking (pi runs them through its `subagent` tool). Models per harness: [compatibility.md](compatibility.md). In Claude Code with `CLAUDE_CODE_SUBAGENT_MODEL=sonnet` set, any subagent that names no model (a plain or general-purpose one) runs on Sonnet; ask for another model by name ("use an opus subagent to …") when the task needs judgement.

## guard: what it does to the agent

You never call guard. You see it when it denies or asks:

| You see | Why | What to do |
|---|---|---|
| A commit or PR command denied once with "load skill X" | The first `git commit`, `gh pr create/merge`, `git worktree add`, or release command of a session needs the matching skill loaded first. | Nothing: the agent loads it and retries. |
| `git commit -m "..."` denied: not a Conventional Commit | Subject must be `type(scope): summary`, types `feat fix perf refactor revert docs style test build ci chore`. Also PR titles. | Nothing: the agent rewrites it. |
| A permission prompt starting `Risky command:`, with `Would affect:` | It says what the risky part does and where (`Deletes recursively: sub/build`, `on pi.local`), the step on its own and the rule. Risky command: `rm -r` (any spelling, `Remove-Item -Recurse`, `rd /s`), `find -delete`, `git push --force`/`--mirror`/`--prune` or deleting main, `git reset --hard`, `git clean -f`, `git checkout .`/`git restore .`, `git stash drop`/`clear`, `git branch -D`, `git rm -f`, `git worktree remove --force`, `git update-ref -d`, `git filter-repo`, `terraform`/`tofu apply/destroy`, `gh pr merge --admin`, data-loss deletes outside git (`docker volume rm`/`prune`, `docker system prune`, `docker rm -v`, `docker compose down -v`, `gh repo|release|secret delete`, `gh api -X DELETE`, `kubectl delete`, `helm uninstall`, `gcloud`/`az … delete`, `dd of=/dev/…`, `mkfs`), also behind `git -C dir`, inside `bash -c`, `eval`, `ssh` and `docker exec`. Deletes under a temp dir, of a clean, pushed or merged worktree, of git-ignored build output (`node_modules`, `dist`, `.venv`, ...) and of a pushed or merged branch skip it. | Read the summary and preview, then allow or deny. A risky step inside a chain of more than 3 commands, or next to other commands in `bash -c`/`ssh`, is denied instead: the agent re-runs it on its own. |
| A note after `sed -i`, `echo > file` or inline Python writing a file | The agent edited a file through the shell, which skips the post-edit lint and the docs hints. Once per session. | Nothing: the agent switches to its edit tool. |
| A permission prompt naming `secrets-handling` | A command that reads or prints a secret: `bw`/`bws` get/list/run/unlock/login/export, `security find-generic-password -w`, `chezmoi secret keyring get`, `op read`, `pass show`, `gcloud secrets versions access`, `az keyvault secret show`, `gh auth token`, `gcloud auth print-access-token`, a bare `env`/`printenv` dump, `printenv`/`env \| grep TOKEN`, `echo $GITHUB_TOKEN`, any reader of `.env`, `~/.aws/credentials` or a private ssh key. A token injected with `VAR="$(…)" ./script` does not ask. | Allow when the task needs it; the value must not reach the chat. |
| `pip`/`poetry` denied: "This repo uses uv" | The repo has `uv.lock` (or a plain `pyproject.toml`). In a poetry or pip repo it runs, with a one-time note. | Nothing: the agent switches to `uv`. |
| A heavy build or test run denied once | Load over 30, CPU over 90 % or under 20 GB free disk. | Wait, or let the agent wrap it in `heavy.sh`. |
| Subagent spawn refused (Claude Code) | A plan window is at 90 %. | Wait for the reset. |
| The agent keeps working after it said "done" | `make check` failed on stop (only when the repo changed since the last green run). | Nothing: it fixes the failure once, then may stop. |
| Shellcheck/PSScriptAnalyzer findings after an edit | An edited `.sh`/`.bash`/`.ps1` has lint findings. | Nothing: advice for the agent. |

It also keeps the machine awake while the harness runs.

Settings are env vars, set in the shell that starts the harness (or the `env` block of Claude Code's settings):

| Variable | Default | Effect |
|---|---|---|
| `GUARD_UNATTENDED=1` | off | Every risky ask becomes a deny, and Claude Code parks its permission asks at once. Use for overnight and headless runs (`unattended-runs` skill). Set it in the launching shell or Claude Code's settings `env`; a command that exports it in the session holds for the rest of the session ([guard.md](guard.md#unattended-and-auto-approve-runs)). |
| `GUARD_STOP_CHECK=off` | on | Turns off `make check` on stop. |
| `GUARD_STOP_TIMEOUT_MS` | `300000` | Time limit for that check; a timeout defers it to the next stop, never blocks. |
| `GUARD_ASK_TIMEOUT_MS` | `60000` | Claude Code: an unanswered permission prompt is parked after this (the agent is told nobody answered and to carry on, not that you denied it); `0` turns it off. |
| `GUARD_OTEL=off` | on | Sends no guard telemetry, whatever the OTel endpoint (`make test` sets it). |
| `GUARD_OTEL_EXPORTER_OTLP_ENDPOINT`, `GUARD_OTEL_EXPORTER_OTLP_HEADERS` | unset | Send each deny and ask to Grafana as logs ([guard.md](guard.md#grafana)). |

A repo with a slow suite defines a `check-fast` make target; the stop hook runs that instead of `check`.

With that telemetry in Loki, `/agent-review` in a session opened in a clone of this repo reviews cost, skill use, guard reminders and subagent routing for the week ([agent-review.md](agent-review.md)).

## hud: what's on screen

Claude Code shows everything; Copilot CLI and pi a subset ([compatibility.md](compatibility.md)). Sample output for each part: [hud plugin README](../plugins/hud/README.md).

| Part | Where | Shows |
|---|---|---|
| Status line | bottom two lines | user@host, branch and dirty mark, GCP project, session; path, model, context %, 5h and 7d limits with reset time, cost |
| Band | above the prompt | cache hit %, prompt-cache countdown, context sparkline; the branch's PR with CI (click to open); unpushed and uncommitted work; a forecast when a limit will fill before it resets; running subagents |
| Spinner | while a tool runs | the tool's verb |
| Turn footer | under a turn | duration, tokens in and out, cache hit %, cost |
| Tool rows | each tool call | icon coloured by outcome, `+N -N` on edits, time |
| Reply rewrites | in replies | `#12` and commits as links with their state, paths shortened and opening your editor, long URLs shortened, ISO times in local time, pass/fail as ✓ ✗ ⊘ with counts, secrets masked |

Commands:

| Command | Harness | Opens |
|---|---|---|
| `/weather` | Claude Code | context chart, per-turn table, last turn's tokens, 5h and 7d history, cache TTL |
| `/ctx` | Claude Code | the context breakdown as a coloured grid |
| `/subagents` | Claude Code | every subagent: type, task, model, time, tokens, outcome |
| `/refresh-refs` | Claude Code, pi | forgets cached PR/issue states, files and commits so replies look them up again |

The status line needs one line in settings; see [hud.md](hud.md#install).

Settings: Claude Code `/config`, rows `hud.*`; pi `~/.pi/agent/hud.json`. Each `reply*` setting takes `on`, `off`, `no-glyph`, `no-colour` or `plain`.

| Setting | Default | Controls |
|---|---|---|
| `replyRefs`, `replyState` | on | `#12` links and their open/merged/closed colour |
| `replyPaths`, `replyFileLinks` | on | short paths; `file:line` opens the editor |
| `replyCommits`, `replyUrls`, `replyTimes`, `replyStatus`, `replySecrets` | on | commit links, short URLs, local times, ✓ ✗ ⊘, masked secrets |
| `editor` | `vscode` | `cursor`, `zed`, `idea`, `sublime`, `file`, or `custom` with `editorUrl` (`{path}` `{line}` `{col}`) |
| `timeFormat` | `both` | `absolute`, `relative` |
| `glyphs`, `colour` | true | every icon or colour at once (`NO_COLOR` also turns colour off) |

Details and examples: [hud.md](hud.md#reply-rewrites).

## sounds: alerts

Toasts appear when context passes 80 % and 90 %, a limit window passes 80 %, 90 % and 100 %, and the prompt cache is a minute from expiring or has expired. Sounds play on macOS only. Claude Code has every setting below in `/config` (rows `sounds.*`); pi, Codex and opencode play the defaults for turns, context and prompts waiting on you.

| Setting | Plays on | Default |
|---|---|---|
| `soundDone` | a turn answered (at least `doneAfterSeconds`, default 0) | `done` |
| `soundNeedsInput` | a permission prompt or a question waiting on you | `chime` |
| `soundContext` | context past 80 %, 90 % | `alert` |
| `soundLimit5h`, `soundLimit7d`, `soundLimitSpend` | a limit window past 80 %, 90 %, 100 % | `warn` |
| `soundCacheExpiring`, `soundCacheExpired` | the prompt cache about to expire, expired | `ping`, `warn` |
| `soundError`, `soundRefused`, `soundAborted` | a turn ended by an API error, a refusal, an interrupt | `error`, `error`, `off` |
| `soundSubagent` | a subagent finished | `tick` |
| `soundGain` | volume, 0 to 4 | |
| `notify`, `notifyAfterSeconds` | system notification for long turns (60 s), errors, questions, PR checks finishing | on |

Each sound picks from `off`, `chime`, `ping`, `alert`, `warn`, `error`, `done`, `tick`. Details: [sounds.md](sounds.md).

## Limits to know

- **One working directory per session.** With `claude --add-dir`, skills and edits reach the added directories, but hud's PR strip, links and status line and guard's `make check` on stop follow the directory the session started in. Run one session per repo or worktree instead.
- **Other harnesses get less.** No band, panes or reply colours outside Claude Code; no sounds off macOS. Exact matrix: [compatibility.md](compatibility.md).
- **Updates need a version bump.** An installed plugin updates only when its version changes: `claude plugin marketplace update giocaizzi-harness`, then `claude plugin update <plugin>@giocaizzi-harness`, then restart. Other harnesses: [install.md](install.md).

## Troubleshooting

| Symptom | Where to look |
|---|---|
| Nothing from guard, a hook denies every call, Codex hooks silent | [guard.md](guard.md#troubleshooting) |
| Icons are boxes | Install a Nerd Font in the terminal, or set `glyphs` to false. |
| Status line missing | The `statusLine` entry in settings ([hud.md](hud.md#install)); `node` 22+ on PATH. |
| No sounds | macOS only; check the `sounds.*` rows in `/config`. |
| A merged change does not show | Update both the marketplace and the plugin, then restart (above). |
