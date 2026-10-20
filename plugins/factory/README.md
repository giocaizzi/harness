# `factory` plugin

Attended ticket runs on a GitHub issue board: an owner-approved ticket worked end to end, its scope decided by a fold-in test and logged on the ticket, questions asked on the ticket, and a result contract per run. Generic for any repo; the repo's own settings live in its `.factory/config.yaml`. Design, protocol and contract: [docs/factory.md](../../docs/factory.md); adoption runbook: [docs/adopt-factory.md](../../docs/adopt-factory.md).

## Skills

| Skill | Description |
|---|---|
| `ticket-run` | One approved ticket end to end, attended: approval gate, plan comment, fold-in test and decision log, questions that park the ticket, verifier, ship, deploy and live verify, result (`/ticket-run <number>`). |

## Agents

| Agent | Description |
|---|---|
| `verifier` | Fresh-context gate before a ticket ships: every change traces to the ticket or its decision log, side effects present, acceptance evidence that could fail. Preset at `high` effort, the one exception in `subagent-orchestration`. |

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
