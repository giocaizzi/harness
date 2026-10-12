# sounds

Toasts and sounds for Claude Code, drawn by a mod. The visual display is [hud](hud.md); guardrails are [guard](guard.md).

## Architecture

| Path | Role |
|---|---|
| `hooks/mod.mjs` | Claude Code mod: toasts and clips on `turn.complete` and on a one-second clock for the cache expiry. `types/index.d.ts` declares its `$.state`. |
| `hooks/alerts.mjs` | Pure logic: which alerts a turn raises (`alerts`) and which sound a finished turn plays (`turnSound`); node tests in `alerts.test.mjs`. |
| `sounds/*.wav` | The clips: `chime`, `ping`, `alert`, `warn`, `error`, `done`, `tick`. |

## Decisions

- **Alerts.** The context crossing 80% and 90%, each limit window (5h, 7d, gateway spend) crossing 80%, 90% and 100%: one toast each, raised once and re-armed after the level is left (a compaction re-arms the context). A minute before the prompt cache expires and when it has: one toast per turn.
- **Sounds.** Each alert, and each way a turn ends (answer, interrupt, refusal, API error, subagent), has its own `userConfig` picker over `off` and the clips, in `/config`. `doneAfterSeconds` skips the finished sound for shorter turns; `soundGain` sets the volume (0 to 4). Two alerts of one turn that share a sound play it once. Defaults: every sound on but `soundAborted` (a message sent mid-turn instead of queued interrupts the turn, so it would play every time), `doneAfterSeconds` 0.
- **Notifications.** `$.ui.notify` through the person's own channel (`preferredNotifChannel`): a main-loop turn of at least `notifyAfterSeconds` finishing, a refusal or API error, an `AskUserQuestion` call, and the PR checks going from running to passed or failed. The last reads the `hud` plugin's PR state by hooking its `state.set`, so it needs `hud` and costs no `gh` call of its own. `notify: false` turns all of them off.
- **macOS only.** The engine plays clips with `afplay`; Linux and Windows terminals have no player and play nothing. Copilot CLI and VS Code have no mods API ([#47](https://github.com/giocaizzi/harness/issues/47)).

## Install

```bash
/plugin install sounds@giocaizzi-harness
```

Settings: `/config`, rows `sounds.soundLimit5h` and the rest.

## Verify

`make check` runs `alerts.test.mjs` and `claude plugin test plugins/sounds`. Live: `afplay plugins/sounds/sounds/done.wav` plays a clip; a session crossing 80% context shows the toast and plays `soundContext`.
