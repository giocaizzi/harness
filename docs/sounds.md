# sounds

Toasts and sounds for Claude Code, drawn by a mod; the turn and context alerts with the default clips for pi, Codex and opencode. The visual display is [hud](hud.md); guardrails are [guard](guard.md).

## Architecture

| Path | Role |
|---|---|
| `hooks/mod.mjs` | Claude Code mod: toasts and clips on `turn.complete` and on a one-second clock for the cache expiry. `types/index.d.ts` declares its `$.state`. |
| `hooks/alerts.mjs` | Pure logic: which alerts a turn raises (`alerts`), which sound a finished turn plays (`turnSound`), and `settle`, the clips and notices with the default `CLIPS` for the harnesses without settings; node tests in `alerts.test.mjs`. |
| `hooks/play.mjs` | `afplay` for pi, Codex and opencode: detached, so a hook process does not wait for the clip. |
| `hooks/pi.mjs` | pi extension (loaded from the root `package.json`). |
| `hooks/codex.mjs` | Codex `Stop` and `PermissionRequest` hooks, named by `hooks/codex-only.json`, which `make build` merges into the generated `hooks/codex.json`. |
| `hooks/opencode.mjs` | opencode plugin; `scripts/install.mjs` writes the stub `~/.config/opencode/plugins/giocaizzi-sounds.js` that re-exports it. |
| `sounds/*.wav` | The clips: `chime`, `ping`, `alert`, `warn`, `error`, `done`, `tick`. |

## Decisions

- **Alerts.** The context crossing 80% and 90%, each limit window (5h, 7d, gateway spend) crossing 80%, 90% and 100%: one toast each, raised once and re-armed after the level is left (a compaction re-arms the context). A minute before the prompt cache expires and when it has: one toast per turn.
- **Sounds.** Each alert, each way a turn ends (answer, interrupt, refusal, API error, subagent), and a prompt waiting on the person (`soundNeedsInput`) has its own `userConfig` picker over `off` and the clips, in `/config`. `doneAfterSeconds` skips the finished sound for shorter turns; `soundGain` sets the volume (0 to 4). Two alerts of one turn that share a sound play it once. Defaults: every sound on but `soundAborted` (a message sent mid-turn instead of queued interrupts the turn, so it would play every time), `doneAfterSeconds` 0.
- **Needs input.** `soundNeedsInput` (default `chime`) plays on a permission prompt (`classic.PermissionRequest`, once no settings hook beneath decided it) and an `AskUserQuestion` call; the question plays from `tool.call` only, so it does not play twice. Codex plays it from a `PermissionRequest` hook (it fires only when Codex prompts), opencode on the `permission.asked` and `question.asked` events. pi has no permission prompts of its own ([#98](https://github.com/giocaizzi/harness/issues/98)).
- **Notifications.** `$.ui.notify` through the person's own channel (`preferredNotifChannel`): a main-loop turn of at least `notifyAfterSeconds` finishing, a refusal or API error, an `AskUserQuestion` call, and the PR checks going from running to passed or failed. The last reads the `hud` plugin's PR state by hooking its `state.set`, so it needs `hud` and costs no `gh` call of its own. `notify: false` turns all of them off.
- **Terminal bell.** A prompt waiting on the person or a finished turn rings the terminal bell, so the terminal marks the tab (Ghostty: 🔔 in the title, a border, a Dock bounce, per its `bell-features`). Claude Code, Codex and Copilot CLI ring it natively (Claude `preferredNotifChannel: "terminal_bell"`, Codex `[tui] notification_method = "bel"`, Copilot `beep`, on by default; set in the dotfiles), so only opencode and pi ring it from here: `bell` in `hooks/play.mjs` writes BEL to the controlling terminal (`/dev/tty`, `CONOUT$` on Windows) and does nothing without one. opencode rings on `permission.asked`, `question.asked` and a main session's idle (not a subagent's or an interrupted turn); pi on `agent_settled` with a UI, unless aborted.
- **macOS only.** The engine plays clips with `afplay`; Linux and Windows terminals have no player and play nothing. Copilot CLI and VS Code have no mods API ([#47](https://github.com/giocaizzi/harness/issues/47)). pi, Codex and opencode play the same clips through `hooks/play.mjs`, on macOS only too.
- **pi.** `hooks/pi.mjs` plays the default clips (done, error, context alert) on `agent_settled` and shows the turn and context notices with `ctx.ui.notify`. pi has no per-plugin settings, plan windows or cache TTL, so there are no pickers, limit alerts or cache alerts.
- **Codex.** A `Stop` hook and a `PermissionRequest` hook (`hooks/codex.mjs`, which picks by `hook_event_name`; the latter plays `chime` and returns no decision). The payload carries `turn_id` and `transcript_path` but no duration or usage, so the hook reads the turn's rollout: `task_started.started_at` for the duration, an `error` event after it for the error clip, the last `token_count` (`last_token_usage.total_tokens` over `model_context_window`) for the context. The alert levels persist per session in `$PLUGIN_DATA`. Notices go back as `systemMessage`, which Codex shows as a warning. The hook is Codex-only (`hooks/codex-only.json`) because Claude Code, Copilot CLI and VS Code would also run a `Stop` in `hooks.json`, and Claude already plays from the mod. No subagent, interrupt, limit or cache alerts; the limit windows (`rate_limits` in the same `token_count` events) are left for [#68](https://github.com/giocaizzi/harness/issues/68).
- **opencode.** A server plugin (`hooks/opencode.mjs`): `session.idle` ends a turn, timed from the session's last `chat.message`; `session.error` picks the error clip (`MessageAbortedError` is an interrupt, silent); a session created with a `parentID` is a subagent and plays `tick`; the context is the last assistant message's tokens over the model's `limit.context` (`client.config.providers()`). Notices are toasts (`client.tui.showToast`), fire-and-forget so `opencode run` (no TUI) never waits on them. The module exports nothing but the plugin, since opencode calls every exported function as one.

## Install

```bash
/plugin install sounds@giocaizzi-harness     # Claude Code
codex plugin add sounds@giocaizzi-harness    # Codex; then trust its Stop hook in /hooks
make install HARNESS=opencode                # opencode, from a checkout (install.md)
```

pi gets it with the package (`pi install git:github.com/giocaizzi/harness`).

Settings: `/config`, rows `sounds.soundLimit5h` and the rest.

## Verify

`make check` runs the node tests (`alerts`, `pi`, `codex`, `opencode`) and `claude plugin test plugins/sounds`; `make e2e` checks that Codex ran the installed `Stop` hook. Live: `afplay plugins/sounds/sounds/done.wav` plays a clip; a session crossing 80% context shows the toast and plays `soundContext`. Codex: a finished turn plays `done`, and one over a minute shows `Turn finished in …` as a warning. opencode: a turn plays `done` when the session goes idle; one over a minute or past 80% context shows a toast.
