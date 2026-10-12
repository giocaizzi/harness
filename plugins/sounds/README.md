# `sounds` plugin

Toasts and configurable sounds for Claude Code (a mod). No skills or agents. Architecture and runbook: [docs/sounds.md](../../docs/sounds.md).

## Alerts and sounds

| Setting | Plays on | Default |
|---|---|---|
| `soundLimit5h`, `soundLimit7d`, `soundLimitSpend` | The window crossing 80%, 90%, 100% (with a toast) | `warn` |
| `soundContext` | Context crossing 80%, 90% (with a toast) | `alert` |
| `soundCacheExpiring`, `soundCacheExpired` | A minute before the prompt cache expires, and when it has (with a toast) | `ping`, `warn` |
| `soundDone` | A turn answered, at least `doneAfterSeconds` long (default 0) | `done` |
| `soundAborted`, `soundRefused`, `soundError` | A turn interrupted, refused, or ended by an API error | `chime`, `error`, `error` |
| `soundSubagent` | A subagent's turn ended | `tick` |

Each is a picker in `/config` over `off`, `chime`, `ping`, `alert`, `warn`, `error`, `done`, `tick`; `soundGain` sets the volume. Sounds play on macOS only.

## Install

```bash
/plugin install sounds@giocaizzi-harness
```
