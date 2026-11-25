# Plan: guard decoupled, optional and configurable (guard 2.0.0, run contract 3)

Status: implemented on `feat/guard-decouple`, one PR. Delete this note when the PR merges; the lasting text lives in [guard.md](../guard.md).

## Goal

Let any orchestrator (a program that launches a harness for a ticket) use guard without copying guard's internals, and without guard knowing about that orchestrator:

1. Trust the run manifest by a SHA-256 digest from the launch environment, as an alternative to the file-ownership check, which cannot hold when the orchestrator and the agent run as one OS user.
2. Switch each hook rule on or off from one config surface, with documented defaults.
3. Remove the contract v1 tripwire (the eight legacy run variables).
4. Rename the run identity variables to neutral `AGENT_RUN_*` names.
5. Publish a machine-readable hook descriptor, so an orchestrator never embeds a copy of `hooks.json` or absolute versioned paths.
6. Document the events file and OTLP contract as guard's own reference.

## Versioning

Breaking: variable names change and the tripwire goes. Guard 1.5.0 -> 2.0.0 (plugin.json and marketplace entry; this repo bumps by hand, not through release tooling). The run contract's major goes 2 -> 3: guard.md says renaming a run variable is a new contract major, and a runner's `--contract` probe must be able to tell the old names from the new. The manifest's `contract` key must be `3`. No aliases, no deprecation window.

## 4. Run variables

| Old | New |
|---|---|
| `GUARD_RUN_ID` | `AGENT_RUN_ID` |
| `GUARD_RUN_TICKET` | `AGENT_RUN_TICKET` |
| `GUARD_RUN_MODE` | `AGENT_RUN_MODE` |
| `GUARD_RUN_FILE` | `AGENT_RUN_FILE` |
| `GUARD_RUN_MANIFEST` | `AGENT_RUN_MANIFEST` |
| (new) | `AGENT_RUN_MANIFEST_SHA256` |
| `GUARD_RUN_EVENTS_FILE` | `AGENT_RUN_EVENTS_FILE` |
| `GUARD_RUN_PROTECTED_PATHS` | `AGENT_RUN_PROTECTED_PATHS` (open question: rename or drop) |

Unchanged: every other `GUARD_*` switch (`GUARD_OTEL*`, `GUARD_TRACEPARENT`, `GUARD_RESULT_GATE`, `GUARD_UNATTENDED`, ...). The checker contract is unchanged: `resultErrors(result, env)`, with `AGENT_RUN_FILE` resolved against the session's cwd in an unattended run.

## 3. Tripwire removal

Delete `LEGACY_VARS`, `legacySet`, `recordUnregistered`, the `run-unregistered` rule and log, their tests, the contract-kit scenario and every doc mention. A session that sets only `FACTORY_*` is an ordinary unregistered session.

## 1. Manifest trust by digest

Two trust modes, picked by the environment:

- **Ownership (default).** `AGENT_RUN_MANIFEST_SHA256` unset: today's `vetTrustedFile` (file, directory and ancestors out of the hook user's reach).
- **Digest.** `AGENT_RUN_MANIFEST_SHA256` set: the path is still vetted for shape (absolute, `.json`, regular, readable, at most 64 KiB), the ownership and writability checks are skipped, and the bytes guard reads are accepted only when their SHA-256 equals the digest (64 lowercase hex; any other value, blank included, denies). Hash and parse use the same buffer, so there is no window between check and use. Mismatch denies with rule `run-registration` (fail closed), like any registration failure. The session pin keeps working as now.
- **Checker under a digest.** A manifest trusted by digest whose `result` names a `checker` must also carry `result.checker_sha256` (64 hex; a contract minor addition, allowed in ownership mode too, where it adds a check). The gate reads the checker file once, compares its SHA-256, and the child process imports those verified bytes (a `data:` URL), never the path again: a checker in the agent's reach cannot be swapped between check and import. Consequence: such a checker must be one self-contained module (no relative imports). Without `checker_sha256` in digest mode the registration denies.

Threat model: the agent can rewrite any file its user owns, the manifest and checker included, but not the environment of the harness process that is already running (and so of the hooks it spawns). The digest must be computed by the launcher from the manifest it wrote, and passed in the harness's launch environment (process env, never a file the agent can write, never the command line of a tool call). Known limits carried over: an in-process harness (opencode, pi) whose project plugins run with the host's privileges, and a Claude Code settings `env` block the agent can edit, can set environment variables; the runner protects those files (protected paths) or locks the config. The data dir stays untrusted as before.

## 2. Rule toggles

One variable, `GUARD_RULES`, read from the hook's environment like every other switch (the launcher's; a command prefix changes nothing). Env only, no config file: a file the agent can write would let it switch rules off, and the environment is already guard's trust boundary.

Grammar: comma- or space-separated tokens applied left to right over the defaults: `all` or `none` set every rule, `<id>` or `+<id>` turns one on, `-<id>` turns one off. An unknown token makes the whole value invalid: guard then uses the defaults (all on) and says so once per session (fails toward more checks). Examples: `GUARD_RULES=none,risky,run-labels,protected-paths,result-gate`; `GUARD_RULES=-awake,-lint`.

| Id | Rule | Default |
|---|---|---|
| `risky` | Risky-command ask (and its unattended deny) | on |
| `title` | Commit and PR title guard | on |
| `python` | pip/poetry deny in a uv repo | on |
| `skills` | Skill rules: the deny-once enforcer and the skill reminders | on |
| `hints` | Read, edit and routing hints | on |
| `host` | Host-strain deny (also `GUARD_HOST_CHECK=off`) | on |
| `push-scan` | gitleaks before push (also `GUARD_PUSH_SCAN=off`) | on |
| `pr-batch` | PR batching deny | on |
| `stack-hint` | Stack rule: stacked-create deny and stacked-PR hints (also `GUARD_STACK_HINT=off`) | on |
| `stale-plugins` | Stale-plugins note | on |
| `lifecycle` | Repo sweep and branch-lifecycle reminder (also `GUARD_LIFECYCLE=off`) | on |
| `stop-check` | `make check` on stop (also `GUARD_STOP_CHECK=off`) | on |
| `lint` | Post-edit lint | on |
| `awake` | Keep-awake keeper | on |
| `run-labels` | Run label rules (`run-label`, `run-config`) | on |
| `protected-paths` | Run protected-path deny | on |
| `result-gate` | Run result gate (also `GUARD_RESULT_GATE=off`) | on |

The older single switches keep working: a rule runs only when `GUARD_RULES` enables it and its own switch is not off. Floor: in a registered run, a rule backing a capability the manifest `requires` (`labels` -> `run-labels`, `protected-paths`, `result-gate`) runs whatever `GUARD_RULES` says, so toggles never loosen a registration. A registration failure always denies. One pure module (`core/toggles`) parses the value; the engine takes the set and skips disabled rules where they are evaluated, so a disabled rule never hides an enabled one on the same command.

## 5. Hook descriptor

`node <plugin root>/hooks/guard.mjs --describe` prints one JSON object and exits 0 without reading stdin, built at run time from the installed `hooks.json` and the generated Codex file, so it never drifts and names the absolute paths of the copy that answers:

```json
{
  "descriptor": 1,
  "guard": "2.0.0",
  "contract": 3,
  "root": "/abs/plugin/root",
  "harnesses": {
    "claude-code": { "kind": "command", "hooks": { "PreToolUse": [ { "matcher": "Bash|…", "argv": ["node", "/abs/plugin/root/hooks/guard.mjs", "PreToolUse"], "timeout": 30 } ] } },
    "copilot-cli": { "kind": "command", "hooks": { … } },
    "vscode-copilot": { "kind": "command", "hooks": { … } },
    "codex-cli": { "kind": "command", "hooks": { … } },
    "opencode": { "kind": "module", "module": "/abs/plugin/root/hooks/opencode.mjs" },
    "pi": { "kind": "module", "module": "/abs/plugin/root/hooks/pi.mjs" },
    "antigravity": { "kind": "command", "hooks": { … } }
  },
  "env": { "run": ["AGENT_RUN_ID", "…"], "switches": ["GUARD_RULES", "…"] },
  "rules": { "risky": true, "…": true }
}
```

`argv` is an argument vector (no shell, no `${CLAUDE_PLUGIN_ROOT}`), `timeout` in seconds, `rules` the effective toggles for the environment the probe ran in. `--contract` stays as is (contract 3).

## 6. Events and OTLP contract

A new reference section in guard.md: the events-file line schema (`ts`, `decision`, `rule`, `cmd_hash`, optional `trace_id`/`span_id`, which decisions are written, never allows), its write semantics (append, one line per decision, best effort), the OTLP log records guard emits (event names and attributes), the `GUARD_OTEL*` and `GUARD_TRACEPARENT` inputs, and what is versioned with the contract.

## Units

Groundwork first, on the branch: (A) renames, contract 3, tripwire removal. Then in parallel: (B) digest trust, (C) descriptor. Then (D) rule toggles, which touches `guard.mts`, `stop.mts` and the engine that B and C also touch. Each unit updates its own docs section and tests; the version bump is the last commit. Checks: `make build`, `make validate`, `make check` (through the host's heavy-job wrapper).

## Open questions

- `GUARD_RUN_PROTECTED_PATHS`: renamed to `AGENT_RUN_PROTECTED_PATHS` (recommended, keeps the feature) or dropped (manifest globs only).
- Old switches (`GUARD_STOP_CHECK`, `GUARD_LIFECYCLE`, ...): kept beside `GUARD_RULES` (recommended now) or folded into it in a later major.
- Resolved in review: a runner still setting `GUARD_RUN_*` fails closed (`run-registration`) unless each old name equals its `AGENT_RUN_*` twin, and the probe rule is a MUST (contract equals the runner's major).
