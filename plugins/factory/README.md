# `factory` plugin

Attended ticket runs on a GitHub issue board: an owner-approved ticket worked end to end, its scope decided by a fold-in test and logged on the ticket, questions asked on the ticket, and a result contract per run. Generic for any repo; the repo's own settings live in its `.factory/config.yaml`. Design, protocol and contract: [docs/factory.md](../../docs/factory.md); adoption runbook: [docs/adopt-factory.md](../../docs/adopt-factory.md).

Requires the `dev-tools` plugin (its agents and its `wt`, `ship` and `land` skills) and the `guard` plugin (the label and self-approval denies a runtime run relies on; recommended attended). Claude Code installs both with it (manifest `dependencies`); in the other harnesses install them yourself.

## Skills

| Skill | Description |
|---|---|
| `ticket-run` | One approved ticket end to end, attended: approval gate, plan comment, fold-in test and decision log, questions that park the ticket, takeover of a runtime run, verifier, ship, deploy and live verify, result (`/ticket-run <number>`). |
| `factory-status` | Read-only list of the factory's tickets: halted and quarantined, needs you (with the open question or a takeover), in progress, grooming, approved and not started, recently done (`/factory-status [days]`). |

## Agents

| Agent | Description |
|---|---|
| `verifier` | The reviewer for factory tickets: a fresh-context gate before a ticket ships that checks correctness, that every change traces to the ticket or its decision log, side effects and acceptance evidence that could fail. Preset at `medium` effort; the run spawns it at `high` for security or safety paths. |

On pi, the `dev-tools` `subagent` tool runs it in its own `pi -p` session.

## Template

| File | Purpose |
|---|---|
| `template/config.yaml` | The `.factory/config.yaml` a repo adopts, placeholders only. |
| `template/result.json` | The shape of `.factory/runs/<number>/result.json` each run writes. |

## Install

```bash
# Claude Code / Copilot CLI / Codex (codex plugin add)
/plugin install factory@giocaizzi-harness
```

Every harness (Codex, opencode and pi included), updates and local development: [docs/install.md](../../docs/install.md).
