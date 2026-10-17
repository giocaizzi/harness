# `sounds` plugin

Toasts and configurable sounds for Claude Code (a mod), and the turn and context alerts with the default clips for pi (`hooks/pi.mjs`), Codex (a `Stop` hook, `hooks/codex.mjs`) and opencode (`hooks/opencode.mjs`). No skills or agents. Architecture and runbook: [docs/sounds.md](../../docs/sounds.md).

## Alerts and sounds

| Setting | Plays on | Default |
|---|---|---|
| `soundLimit5h`, `soundLimit7d`, `soundLimitSpend` | The window crossing 80%, 90%, 100% (with a toast) | `warn` |
| `soundContext` | Context crossing 80%, 90% (with a toast) | `alert` |
| `soundCacheExpiring`, `soundCacheExpired` | A minute before the prompt cache expires, and when it has (with a toast) | `ping`, `warn` |
| `soundDone` | A turn answered, at least `doneAfterSeconds` long (default 0) | `done` |
| `soundAborted`, `soundRefused`, `soundError` | A turn interrupted (also a message sent mid-turn), refused, or ended by an API error | `off`, `error`, `error` |
| `soundSubagent` | A subagent's turn ended | `tick` |
| `soundNeedsInput` | A permission prompt or a question waiting on you (also Codex and opencode) | `chime` |
| `notify` | System notification: a turn of at least `notifyAfterSeconds` (default 60) finishing or ending badly, Claude asking a question, the PR checks finishing (with `hud`) | on |

Each sound is a picker in `/config` over `off`, `chime`, `ping`, `alert`, `warn`, `error`, `done`, `tick`; `soundGain` sets the volume. Sounds play on macOS only.

## Install

```bash
/plugin install sounds@giocaizzi-harness     # Claude Code
codex plugin add sounds@giocaizzi-harness    # Codex; trust the hook in /hooks
make install HARNESS=opencode                # opencode, from a checkout
```
