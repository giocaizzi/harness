# Guard events

What guard writes outside the harness: the run events file and the OTLP log records. This is the reference for readers of either (a runner, an orchestrator, a collector or dashboard); link here instead of copying it. How guard decides, and the run contract it belongs to: [guard.md](guard.md). Dashboards and the Loki how-to: [guard.md](guard.md#grafana).

Written from `src/plugins/guard/hooks/telemetry.mts` (`appendDecision`), `src/plugins/guard/core/otel.mts` (the OTLP request) and the call sites of both; the tests that pin them are `telemetry.test.mts`, `guard.test.mts` and `otel.test.mts`.

## Run events file

A runner sets `AGENT_RUN_EVENTS_FILE` to a writable file path for the run it starts ([Run contract v3](guard.md#run-contract-v3)). Guard appends one line for each decision that stops or interrupts a tool call, so the runner can count denies and asks (its deny-rate breaker reads it).

**What is written.** Only the decisions `deny` and `ask`, as the effective action after the harness transforms: an ask turned into a deny (an unattended run, a harness that cannot ask) is `deny`; an ask left to the harness's own prompt is `ask`. The cases:

- a rule's deny or ask on a shell command (including the host, push-scan and run rules);
- a registration deny: with a failed run registration, every tool call guard sees is denied, rule `run-registration`; the line carries `cmd_hash` only when the tool is a shell tool;
- an edit-tool deny of a protected path in an unattended registered run (rule `protected-path`, no `cmd_hash`);
- fail-closed denies: `guard-error` (guard crashed on a risky command, or on any command in an unattended registered run) and `guard-input` (a tool call guard could not read whole; no `cmd_hash`).

**What is never written.** Allows (sampled or not), reminders, hints such as `pr-batch`, and every other record kind (`guard.session`, `guard.stop`, `guard.skill`, `guard.ask_result`, `guard.throttle`, `api_request`): those go to OTLP only. The command text is never written, only its hash.

**Line format.** One JSON object per line, keys in this order:

| Field | Type | Present | Meaning |
|---|---|---|---|
| `ts` | string | always | When guard wrote the line, ISO 8601 UTC (`Date.toISOString()`). |
| `decision` | string | always | `deny` or `ask`. |
| `rule` | string | normally | The rule id that decided ([rule ids](#rule-ids)). Absent when the decision carries none. |
| `cmd_hash` | string | for a shell command | First 12 hex characters of the sha256 of the command with leading and trailing whitespace trimmed and runs of whitespace collapsed to one space. Counts repeats without the text. Absent for an edit-tool deny, `guard-input`, and a registration deny on a non-shell tool. |
| `trace_id` | string | with a trace context | 32 lowercase hex: the trace id of a well-formed `GUARD_TRACEPARENT` ([Trace context](#trace-context)). |
| `span_id` | string | with a trace context | 16 lowercase hex: the span id of the same value. |

There is no `via` or `reason` field: the harness transform that produced a `deny` from an ask is visible only in OTLP (`guard.decision` `via`).

```json
{"ts":"2026-05-01T09:30:12.481Z","decision":"deny","rule":"title","cmd_hash":"3f1c9ab07e22","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","span_id":"00f067aa0ba902b7"}
```

**Write semantics.**

- Append, one `JSON.stringify` line ending in `\n`, with `appendFileSync` (opened `O_APPEND`), so concurrent hook processes interleave whole lines. Guard never creates the directory, truncates or rotates the file; the runner owns the path.
- Best effort: a failed write (missing directory, unwritable path) is dropped and the decision stands. Telemetry never blocks a decision.
- An unset, empty or whitespace-only value writes nothing. Set it empty to turn the file off in a probe or test run started inside a runner's run (`make test` does).
- Independent of OTLP: it works in every harness, with or without an endpoint and whatever `GUARD_OTEL` says. It is not pinned to the registration: changing it mid-session changes where later lines go ([guard.md](guard.md#run-contract-v3), Known limits).

### Rule ids

`rule` is the same id as the `guard.decision` attribute of that name.

- The run rules (`run-label`, `run-config`, `protected-path`, `run-registration`): [guard.md](guard.md#run-contract-v3), Rule ids.
- Fail-closed: `guard-error` and `guard-input`, above.
- The command rules (deletes, git history and discards, infra, secrets, opaque commands, title, host, pip and poetry, push scan, skill and no-verify rules, ...): the id of the rule in `core/engine.mts`; the `cmd_class` family of each is the `RULE_FAMILY` table there. [guard.md](guard.md#decisions) describes what each family does.

## OTLP logs

Guard also sends each record as an OpenTelemetry log to the collector the harness already exports to. It is off unless an endpoint is set.

**Inputs.** Each variable is read from the hook's environment; Claude Code and Copilot CLI strip `OTEL_*` from command hooks, so each falls back to a `GUARD_`-prefixed copy that the shell launching the harness exports. The first non-empty of the two is used.

| Variable | Fallback | Meaning |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `GUARD_OTEL_EXPORTER_OTLP_ENDPOINT` | Base URL of the collector. Nothing is sent when neither is set. |
| `OTEL_EXPORTER_OTLP_HEADERS` | `GUARD_OTEL_EXPORTER_OTLP_HEADERS` | `k=v,k=v` request headers (auth); percent-decoded values; never logged. |
| `OTEL_RESOURCE_ATTRIBUTES` | `GUARD_OTEL_RESOURCE_ATTRIBUTES` | `k=v,k=v` resource attributes added to every record. |
| `GUARD_OTEL` | none | `off`, `0` or `false` (any case) sends nothing, whatever the endpoint. Probes and `make test` set it. |
| `GUARD_TRACEPARENT` | none | Trace context, [below](#trace-context). |

**Transport.** OTLP/HTTP with a JSON body: `POST <endpoint>/v1/logs` (trailing slashes of the endpoint dropped), `content-type: application/json` plus the configured headers. Logs only: guard creates no OTLP metrics or spans. A send that fails or takes longer than 2 s is dropped and the decision stands (command hooks and the opencode, pi and Antigravity adapters; the Claude mod's records go through the mod host's `fetch`, which guard gives no timeout of its own, and they never delay a decision except the throttle's, which is sent before the spawn continues).

**Record shape.** One `resourceLogs` entry, scope `guard`, one record: `severityText` `INFO`, `body` the record name, `timeUnixNano`, `traceId` and `spanId` when there is a trace context, and the attributes. `event.name` is added as an attribute with the same name as the body. Every attribute value is sent as a string; an attribute whose value is null or undefined is left out.

**Resource.** The configured `OTEL_RESOURCE_ATTRIBUTES` plus `service.name=guard` (it overrides a configured one). `host.name`, when configured, is trimmed of whitespace and trailing dots and shortened to its first DNS label (`localhost` and IP literals kept); guard never derives one. The one exception is the synthetic usage record, whose `service.name` and `service.namespace` are the canonical harness (`opencode`, `pi`, `antigravity`) so usage queries keep the harness identity.

**Common attributes.** Every record carries `harness` (canonical: `claude-code`, `copilot-cli`, `vscode-copilot`, `codex-cli`, `opencode`, `pi`, `antigravity`), `harness_legacy` for the four renamed values only (`claude`, `copilot`, `vscode`, `codex`), `guard_version` and `repo` (`owner/name` of the session's `origin` remote, else its first remote; never a host, user or token; null for a local path, outside git or without a remote). The synthetic usage record carries `harness` and `harness_legacy` but `repo` only when its working directory is known.

**Records.** Attributes below are those the code sets, on top of the common ones; "when" means the attribute is left out otherwise.

| Record | Sent when | Attributes |
|---|---|---|
| `guard.decision` | Every deny and ask, every unsampled host allow, one in 10 other allows, and a `pr-batch` hint. Not every record also goes to the events file ([what is written](#run-events-file)). | `rule`; `action` (`deny`, `ask`, `allow`), the effective action; `via` when a harness transform or a special case applied: `unattended` (ask turned deny by `GUARD_UNATTENDED`), `no-ask` (deny: no prompt covers the form), `native-ask` (ask left to the harness's own prompt), `split` (deny of a split command), `read` (an allowed plain read); `cmd_class`; `tool`; `session_id`; `tool_use_id`; `cmd_hash` for a shell command (same value as the events file); `load1`, `cpu_percent`, `free_gb` when `rule=host`; `sample_rate` on an allow (`10` for the sampled rest, `1` for a host-judged allow: weight by it); `findings`, `private_findings` on `push-scan`; `reason` on `pr-batch`: the accepted split reason on the allow hint, `invalid` or `none` on its deny. |
| `guard.session` | Once per session id and harness process, at start (a resume or restart announces again, a compact does not). | `session_id`; `source` (`startup`, `resume`, `clear`, `compact`, where the harness sends one); `plugin_version_<plugin>` for each installed plugin of this marketplace (non-alphanumerics as `_`); `run.registered` (bool); for a registered run `runner.name`, `runner.contract`, `runner.manifest_sha16` (first 16 hex of the manifest's sha256). No paths or env values. |
| `guard.stop` | Each stop check, and each run result gate outcome. | `cmd_class=stop`; `session_id` (where the harness gives one); `target` (the make target, or `result-gate`); `result`: `pass`, `fail`, `deferred` for a stop check, `block`, `capped`, `registration` or `error` for the result gate; `duration_ms`; `why` (deferral reason, or the masked gate error); `failed_target` and `last_line` (output's last line, secrets masked, cut to 200 characters) on `fail`; `blocks` (count so far) on `block` and `registration`; `mode` (`unattended`, `attended`) and `rule` on the gate's events where they apply. |
| `guard.reminder` | Each skill, routing or lifecycle hint shown. | `rule`; `cmd_class` (`hint`, `routing` or the rule family); `tool` (empty for a stop-time reminder); `session_id`; `tool_use_id` where the harness gives one. |
| `guard.skill` | Each skill newly loaded in a session (a typed `/name` counts only for this marketplace's skills). | `skill`; `cmd_class=skill`; `via` (`tool` or `prompt`); `session_id`. |
| `guard.ask_result` | The answer to an ask the guard showed itself: the Claude mod's dialog, and pi's confirm. Not Copilot CLI, VS Code, Codex or opencode. | `result` (`allow`, `deny`, `timeout`, `unavailable`); `wait_ms`; `tool`; `cmd_class` (the command's family, or `tool`); `via` (`unattended` from the mod when `GUARD_UNATTENDED` parked it at once; `no-ui` from pi without a UI); `tool_use_id` (mod); `session_id` (pi). |
| `guard.throttle` | A spawn the usage throttle judged, from the Claude mod only. | `rule=usage-throttle`; `cmd_class=spawn`; `window` and `percent` (the worst plan window and its use); `action` (`warn`, `allow`, `deny`); `mode` (the `GUARD_THROTTLE` in force); `result` in ask mode (`allow`, `deny`, `timeout`, `unavailable`). |
| `api_request` | Synthetic usage, one per completed model response, for opencode, pi and Antigravity only (the other harnesses export their own). | `usage_schema=guard.usage.v1`; `session.id`, `model`, `provider`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `reasoning_tokens`, `cost_usd`, `cost_source` (`reported`), each only when the adapter observed a valid value. Details: [guard.md](guard.md#synthetic-usage). |

`cmd_class` never carries command text or paths: a rule's family (`delete`, `git-discard`, `git-history`, `infra`, `secrets`, `opaque`, `title`, `host`, `python`, `skill`, `hint`, `routing`, `guard-error`), or the first program's family (`git`, `github`, `build`, `node`, `python`, `read`, `search`, `files`, ...; any program not in the fixed list is `other`, so a private tool's name never leaves the machine).

## Trace context

A runtime that traces a run may set `GUARD_TRACEPARENT` for the run's harness: a W3C `traceparent` naming the span the run's records belong under. It is a separate variable because harnesses replace or strip `TRACEPARENT` and `OTEL_*` in hook environments. Guard reads only this one, derives no context, creates no spans and does not copy the flags.

Well formed: `00-<32 hex trace id>-<16 hex span id>-<2 hex flags>`, lowercase, surrounding whitespace trimmed, neither id all zeros. A higher version (`01` to `fe`) is read by its first 55 characters when they end the value or a `-` follows; `ff` is invalid; version `00` takes nothing after the flags. An absent, empty or malformed value (uppercase hex, wrong length or separator, an all-zero id) adds no trace fields, and never fails, blocks or delays a decision.

Where the ids go:

| Field | Where | Value |
|---|---|---|
| `traceId`, `spanId` | Every OTLP log record guard owns, on the record itself (not attributes), including the Claude mod's and the synthetic usage | 32 and 16 lowercase hex |
| `trace_id`, `span_id` | Each events-file line | the same two values |

`GUARD_TRACEPARENT=00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01` gives `trace_id=4bf92f3577b34da6a3ce929d0e0e4736` and `span_id=00f067aa0ba902b7`. The ids are correlation, not resource identity: configured resource attributes stay ordinary run tags.

## Versioning

- The events-file line is part of the run contract ([guard.md](guard.md#run-contract-v3)): a new optional field is a minor addition, a changed or removed field, value or meaning is a new contract major. A reader ignores fields it does not know.
- OTLP records and attributes are telemetry, not contract: guard may add records and attributes at any time and does not version them. The two stable reads are the record names and the `guard.usage.v1` usage schema.
