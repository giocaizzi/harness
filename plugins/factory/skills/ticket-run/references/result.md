# result.json keys

The contract for `.factory/runs/<number>/result.json`, the source of truth for its keys and their meaning: `scripts/write-result.mjs` fills the ones marked as the script's in [done.md](done.md#record), and `scripts/check-result.mjs` checks the core fields against these lists.

| Key | Type | Meaning |
|---|---|---|
| `schema` | integer | Contract version, `2` (`1` in older results). |
| `ticket` | string | `<owner>/<repo>#<number>`. A runtime sets `FACTORY_TICKET` to the ticket in this form, and `check-result.mjs` checks `ticket` against it exactly. |
| `run_id` | string | `FACTORY_RUN_ID` when a runtime started the run (it sets that variable, plus `FACTORY_DEV=1` in dev mode, and claims under it); else `FACTORY_ATTENDED_RUN_ID` when an attended session was started through the launcher for this ticket ([Attended telemetry](https://github.com/giocaizzi/harness/blob/main/docs/factory.md#attended-telemetry)); else the main session's id where the harness exposes one, else `<host>-<number>-<UTC timestamp>`. Also in the claim comment. |
| `end_state` | `done` \| `parked` \| `failed` \| `budget_reached` \| `halted` | `done`: merged, deployed and verified per the definition of done. `parked`: waiting on the owner (a question, the M+ plan, a merge, or three parks). `failed`: could not be finished for a reason the owner must look at. `budget_reached`: a budget cap stopped the run; a pause, not a failure. `halted`: a runtime stopped the run on a halt (kill switch or circuit breaker) or for a [takeover](https://github.com/giocaizzi/harness/blob/main/docs/factory.md#takeover) (`reason_code: takeover`); written only by the runtime, never by the skills. |
| `reason` | string | Why the run parked or failed; empty when done. |
| `reason_code` | string \| null | Nullable machine-readable `reason` (the specific cause wins over `question` when a park also asks one): `question`, `plan_gate`, `merge_gate`, `grooming`, `verify_rounds`, `live_verify_failed`, `env_blocked`, `budget`, `auth` (a credential or token failure, or a runtime-started run with no trusted claim under its run id) or `takeover` (written only by a runtime, for a run it stopped for a [takeover](https://github.com/giocaizzi/harness/blob/main/docs/factory.md#takeover), and added without a schema bump, so a consumer reads a code it does not know as none); `null` when done or none fits. |
| `phases` | array | `{name, started_at, ended_at}` per run step, in order: `gate`, `plan`, `work`, `verify`, `ship`, `deploy`, `record`, only those the run reached. ISO 8601 timestamps, both keys always present; `ended_at` is `null` for a step the run stopped in, and either is `null` only when the run could not find it (its report says why). Never empty in a result the skills write: a stop at the gate holds `gate` alone. |
| `verifier` | object \| null | `{verdict, rounds}`: the verifier's last verdict (`pass` or `fail`) and how many review rounds ran; `null` when the run stopped before verification. |
| `routing` | array (optional) | `{phase, policy_model, policy_effort, model, effort, deviation_reason}` per spawned phase: what `references/routing.md` prescribes next to what ran. `deviation_reason` is required, non-empty, whenever `model` or `effort` differs from the policy's, else `null`. Absent in older results; a consumer that does not know it ignores it. |
| `mode` | string (optional) | `dev` when the run was started with `FACTORY_DEV=1` (a runtime in dev mode, see [dev mode](https://github.com/giocaizzi/harness/blob/main/plugins/dev-tools/skills/repo-standard/references/dev-mode.md)); absent otherwise, and `dev` is the only value. Absent in older results and in prod runs; a consumer that does not know it ignores it. It does not bump the schema. |
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
| `finished_at` | string | ISO 8601 timestamp of when the run wrote the file; never `null`. |
