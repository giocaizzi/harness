# hud

Heads-up display: what the session costs and where the work stands, drawn by a Claude Code mod and by a status-line script both CLIs run. Guardrails are [guard](guard.md); toasts and sounds are [sounds](sounds.md).

## Architecture

| Path | Role |
|---|---|
| `hooks/mod.mjs` | Claude Code mod (`modules` in `hooks.json`, ignored by Copilot CLI and VS Code): the token-weather band above the prompt, the `/weather` pane, the PR and CI strip and the spinner that names the running tool. `types/index.d.ts` declares its `$.state`. |
| `hooks/footer.mjs`, `tools.mjs`, `agents.mjs`, `context.mjs` | The turn footer, tool rows and spinner, subagent tracker and `/ctx` pane. A module registers one hook per event without a matcher, and each file declares the atoms it reads, so `mod.mjs` holds the shared `session.start` and `turn.complete` hooks that write them. |
| `hooks/weather.mjs` | Pure display logic (forecast, glyphs, sparkline cells, battery, activity labels, PR state), shared with `statusline.mjs`; node tests in `weather.test.mjs`. |
| `hooks/statusline.mjs` | Status line for both CLIs (`statusLine.command`), from the status JSON piped on stdin: the `claude` argument draws Claude Code's two lines (user, host, git, GCP project, session; path, model, context, 5h and 7d battery with reset, cost); no argument draws Copilot CLI's token-weather line. |

## Decisions

- **What goes where.** The status line holds session-long facts (who, where, model, context %, limits, cost). The band, indented one column like the status line, holds what changes fast: last turn's cache hit rate, the prompt-cache TTL countdown, a sparkline of the last 8 turns, the PR with its passed checks, unpushed work and uncommitted changes. The context's weather glyph (sunny to storm as it fills) sits beside `ctx:N%` in the status line, so each icon in the band belongs to the part it sits in. The pane holds detail. The spinner holds nothing but the running tool.
- **The band.** It calls `await next(e)` and draws its line under whatever plugins beneath drew (next-steps and the like), never in their place. Every part sits in brackets (`[ 90%] [ 5:00]`) like the oh-my-posh prompt and the status line. It counts main-loop turns only, suppresses `cache cold` on the first turn (which always writes the cache), forgets the last turn on `/clear`, and counts the prompt-cache TTL (`promptCacheTtl`, `5m` when unset) down from the end of the last turn, redrawing once a second.
- **PR and CI strip.** `gh pr view --json number,statusCheckRollup`, `git rev-list --left-right --count @{u}...HEAD`, `git diff --shortstat HEAD` and `git status --porcelain`, at session start, after each main-loop turn and every minute; either part is left out where `gh` or an upstream is missing.
- **Limit forecast.** The pace of each window over the turns since its last reset (a drop in its percent), projected to 100%; shown only when that comes before the window resets.
- **Turn footer.** A footer carries no turn id, so it matches the latest main-loop turn of the same duration; the cost is the session cost's growth over the turn.
- **Tool rows.** The engine's row is kept and wrapped: an icon coloured by outcome before it, the edit size and the call time (from the `tool.call` hook, by `tool_use_id`) after it.
- **Subagents.** `agent.spawn` records each one, its `turn.complete` closes it; `/subagents` and `/ctx` are named so they do not shadow the built-in `/agents` and `/context`.
- **Clickable PR.** The PR number is a `Link` to its URL; a click opens it where the terminal supports links.
- **Spinner.** A `tool.call` hook records the running tool; the `Spinner` hook draws its icon and verb (` Running`, ` Searching`, ` Editing`, ` Reading`, ` Browsing`, ` Delegating`, ` Calling`) as the `message`, else the engine's own word.
- **Status line in Node, not bash.** One tested script for both CLIs, on every OS. The GCP project is read from gcloud's config files, never by running `gcloud`.
- **Copilot.** No mods API, so no band, pane or spinner ([#47](https://github.com/giocaizzi/harness/issues/47)); Copilot pipes `context_window` and `cost` to its status line, which shows `ctx N% · cache N%` with the session's hit rate and `N req` premium requests (no per-turn usage, no cache TTL, no dollars). VS Code has no status-line hook.

## Install

```bash
/plugin install hud@giocaizzi-harness          # Claude Code
copilot plugin install hud@giocaizzi-harness   # Copilot CLI (status line only)
```

Claude Code status line, in `~/.claude/settings.json` (the marketplace clone has a stable path; the plugin cache path changes with every version):
`"statusLine": { "type": "command", "command": "node ~/.claude/plugins/marketplaces/giocaizzi-harness/plugins/hud/hooks/statusline.mjs claude" }`

Copilot CLI status line, in `~/.copilot/settings.json` (Windows: `%USERPROFILE%\.copilot\settings.json`):
`"statusLine": { "type": "command", "command": "node ~/.copilot/installed-plugins/giocaizzi-harness/hud/hooks/statusline.mjs" }`

Both need `node` 22+ on PATH and a Nerd Font in the terminal (icons show as boxes otherwise). Managed machines set both from the dotfiles.

## Verify

```bash
make check                          # node tests + `claude plugin test plugins/hud`
echo '{"model":{"display_name":"M"},"context_window":{"used_percentage":40}}' | node plugins/hud/hooks/statusline.mjs claude
```

In a live Claude session the band shows the cache and TTL after the first turn and the sparkline after two; `/weather` opens the pane; the spinner names a running tool. In Copilot CLI the status line shows `ctx N%` at once and `cache N%` after the first turn.
