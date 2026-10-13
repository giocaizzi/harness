# hud

Heads-up display: what the session costs and where the work stands, drawn by a Claude Code mod and by a status-line script both CLIs run. Guardrails are [guard](guard.md); toasts and sounds are [sounds](sounds.md).

## Architecture

| Path | Role |
|---|---|
| `hooks/mod.mjs` | Claude Code mod (`modules` in `hooks.json`, ignored by Copilot CLI and VS Code): the token-weather band above the prompt, the `/weather` pane, the PR and CI strip and the spinner that names the running tool. `types/index.d.ts` declares its `$.state`. |
| `hooks/footer.mjs`, `tools.mjs`, `agents.mjs`, `context.mjs` | The turn footer, tool rows and spinner, subagent tracker and `/ctx` pane. A module registers one hook per event without a matcher, and each file declares the atoms it reads, so `mod.mjs` holds the shared `session.start` and `turn.complete` hooks that write them. |
| `hooks/links.mjs` | Pure parser and linker for work-item references (`linkify`, `repoOf`, `pickRemote`), shared by the mod and pi; node tests in `links.test.mjs`. |
| `hooks/pi.mjs`, `hooks/pi-entry.mjs` | pi extension: the footer and the reply links. `pi-entry.mjs` is what `package.json` loads; it adds pi-tui's OSC 8 detection, which only a static import inside pi resolves, so node tests take `pi.mjs`. |
| `hooks/weather.mjs` | Pure display logic (forecast, glyphs, sparkline cells, battery, activity labels, PR state), shared with `statusline.mjs`; node tests in `weather.test.mjs`. |
| `hooks/statusline.mjs` | Status line for both CLIs (`statusLine.command`), from the status JSON piped on stdin: the `claude` argument draws Claude Code's two lines (user, host, git, GCP project, session; path, model, context, 5h and 7d battery with reset, cost); no argument draws Copilot CLI's token-weather line. |

## Decisions

- **One style.** Every part of the status line, the band and Copilot's line is `[icon value]`: one Nerd Font icon from `ICON` in `weather.mjs` (each checked present in JetBrainsMono Nerd Font), dim brackets, the value coloured by state, one space between parts.
- **What goes where.** The status line holds session-long facts (who, where, model, context %, limits, cost). The band, indented one column like the status line, holds what changes fast: last turn's cache hit rate, the prompt-cache TTL countdown, a sparkline of the last 8 turns, the PR with its passed checks, unpushed work and uncommitted changes. The context's weather glyph (sunny to storm as it fills) sits beside `ctx:N%` in the status line, so each icon in the band belongs to the part it sits in. The pane holds detail. The spinner holds nothing but the running tool.
- **The band.** It calls `await next(e)` and draws its line under whatever plugins beneath drew (next-steps and the like), never in their place. Every part sits in brackets (`[ 90%] [ 5:00]`) like the oh-my-posh prompt and the status line. It counts main-loop turns only, suppresses `cache cold` on the first turn (which always writes the cache), forgets the last turn on `/clear`, and counts the prompt-cache TTL (`promptCacheTtl`, `5m` when unset) down from the end of the last turn, redrawing once a second.
- **PR and CI strip.** The forge comes from the `origin` remote: GitHub `gh pr view --json number,url,state,statusCheckRollup`; GitLab `glab mr view --output json` (its head pipeline is the one check); Azure DevOps `az repos pr list --source-branch <branch> --status all --top 1` then `az repos pr policy list --id <n>` (each policy evaluation is a check). Each reader is normalised to number, URL, state and checks. GitLab and Azure are unit-tested against the documented JSON only (no `glab` or `az` on the personal machine). The rest of the strip: `git rev-list --left-right --count @{u}...HEAD`, `git diff --shortstat HEAD` and `git status --porcelain`, at session start, after each main-loop turn and every minute; either part is left out where `gh` or an upstream is missing.
- **Limit forecast.** The pace of each window over the turns since its last reset (a drop in its percent), projected to 100%; shown only when that comes before the window resets.
- **Turn footer.** A footer carries no turn id, so it matches the latest main-loop turn of the same duration; the cost is the session cost's growth over the turn.
- **Tool rows.** The engine's row is kept and wrapped: an icon coloured by outcome before it, the edit size and the call time (from the `tool.call` hook, by `tool_use_id`) after it.
- **Subagents.** `agent.spawn` records each one, its `turn.complete` closes it; `/subagents` and `/ctx` are named so they do not shadow the built-in `/agents` and `/context`.
- **Clickable PR.** The PR number is a `Link` to its URL; a click opens it where the terminal supports links.
- **Clickable work-item references.** `#123`, `!45`, `owner/repo#12` and `AB#77` in a reply become links, without telling the model to write them:
  - Claude Code: a `ui.render` hook on `AssistantMessage` rewrites the block's markdown. It changes the drawing only (the stored message and the model keep the plain text).
  - pi: `message_end` replaces the finished message, so the session file and the model's next turn see the links too. It runs only with a TUI (not `pi -p` or JSON) and only when pi-tui says the terminal takes OSC 8 links. Elsewhere pi prints a link's URL beside it, so the text stays plain.
  - How it's written: each reference becomes a markdown link `[ #12](url)`, which both harnesses' renderers draw as an OSC 8 hyperlink with only the label showing. The label starts with a Nerd Font glyph per kind: `` (nf-oct-issue_opened) for an issue or a GitHub `#N` (GitHub redirects `/issues/N` to `/pull/N`), `` (`ICON.pr`) for a PR or MR, `` (nf-oct-tasklist) for an Azure Boards work item.
  - Colour: markdown carries none, so the renderer's own link colour applies. `linkify`'s `ansi` format has the kind colours for a raw terminal, but nothing uses it yet. With `NO_COLOR` set (non-empty), the glyph is left out.
  - URLs, built from the remote with no API calls:
    - GitHub, and Enterprise hosts named `github…`: `#N` and `owner/repo#N` go to `<host>/<repo>/issues/N`.
    - GitLab: `#N` goes to `/-/issues/N` and `!N` to `/-/merge_requests/N`, also as `group/proj#N` or `group/proj!N`.
    - Azure DevOps: `#N` and `AB#N` go to `dev.azure.com/<org>/<project>/_workitems/edit/N`, and `!N` to `…/_git/<repo>/pullrequest/N`.
    - A reference the forge has no form for stays plain: `!N` and `AB#N` on GitHub, `owner/repo#N` on Azure.
  - Which remote: `upstream` if it exists (in a fork the issues and PRs live on the parent), else `origin`, else the first `git remote` lists. `owner/repo#N` goes to that repo on the same host. The PR strip still reads `origin`.
  - Left alone: fenced code (also while a reply is still streaming in an unclosed fence), code spans, existing markdown links and autolinks, bare URLs, a reference glued to a word or path (`x#1`, `a/#1`, `&#123;`, `C#7`, `github.com/o/r#1`), hex colours with letters (`#fff`, `#1a2b3c`), `#!` shebangs and `# headings`. Known gaps: an all-digit hex colour (`#123456`) links as an issue, and indented code blocks are not detected.
  - Copilot CLI, VS Code, Codex and opencode: not possible, see [#82](https://github.com/giocaizzi/harness/issues/82) and [compatibility](compatibility.md).
- **Spinner.** A `tool.call` hook records the running tool; the `Spinner` hook draws its icon and verb (` Running`, ` Searching`, ` Editing`, ` Reading`, ` Browsing`, ` Delegating`, ` Calling`) as the `message`, else the engine's own word.
- **Status line in Node, not bash.** One tested script for both CLIs, on every OS. The GCP project is read from gcloud's config files, never by running `gcloud`.
- **Copilot.** No mods API, so no band, pane or spinner ([#47](https://github.com/giocaizzi/harness/issues/47)); Copilot pipes `context_window` and `cost` to its status line, which shows `ctx N% · cache N%` with the session's hit rate and `N req` premium requests (no per-turn usage, no cache TTL, no dollars). VS Code has no status-line hook.
- **pi.** `hooks/pi.mjs` (loaded through `pi-entry.mjs`) draws the status line's parts in pi's footer (`ctx.ui.setStatus`): the context weather and percent, the model, the PR with its checks, unpushed and uncommitted work, with the same icons and forge readers (`weather.mjs`). Refreshed at session start and after each run; no band, pane, spinner or limit forecast (pi exposes no plan windows).
- **Codex, opencode.** No mods API and no status-line command, so `hud` does nothing there. Codex's `tui.status_line` takes built-in item ids only. opencode 1.19 has TUI plugins (`@opencode-ai/plugin` `tui.d.ts`: `api.slots.register` with `session_prompt_right`, `sidebar_content`, `sidebar_footer` and more), but a slot renders SolidJS/opentui JSX and the API is undocumented, so the footer is left for [#68](https://github.com/giocaizzi/harness/issues/68).

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

Reply links, live: in a repository with a GitHub, GitLab or Azure DevOps remote, ask the agent to "reply with exactly: Fixed in #12, see `#13`". Claude Code (with hud installed, or `claude --plugin-dir plugins/hud`) and pi (in a terminal that takes OSC 8 links, such as Ghostty, iTerm2, WezTerm or kitty; inside tmux only with the `hyperlinks` terminal feature on an attached client) show ` #12` as a link and `#13` as code. Checked on 2026-10-13: Claude Code 2.1.296 and pi 1.2.0 both emitted `ESC]8;;https://github.com/…/issues/12` around ` #12`.

In a live Claude session the band shows the cache and TTL after the first turn and the sparkline after two; `/weather` opens the pane; the spinner names a running tool. In Copilot CLI the status line shows `ctx N%` at once and `cache N%` after the first turn.
