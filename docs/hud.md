# hud

Heads-up display: what the session costs and where the work stands, drawn by a Claude Code mod and by a status-line script both CLIs run. Guardrails are [guard](guard.md); toasts and sounds are [sounds](sounds.md).

## Architecture

| Path | Role |
|---|---|
| `hooks/mod.mjs` | Claude Code mod (`modules` in `hooks.json`, ignored by Copilot CLI and VS Code): the token-weather band above the prompt, the `/weather` pane, the PR and CI strip and the spinner that names the running tool. `types/index.d.ts` declares its `$.state`. |
| `hooks/footer.mjs`, `tools.mjs`, `agents.mjs`, `context.mjs` | The turn footer, tool rows and spinner, subagent tracker and `/ctx` pane. A module registers one hook per event without a matcher, and each file declares the atoms it reads, so `mod.mjs` holds the shared `session.start` and `turn.complete` hooks that write them. |
| `hooks/rewrite.mjs` | The reply rewrites, pure: each transform, the settings, the cached lookups (`createFacts`) and the forge state readers (`fetchState`); shared by the mod and pi; node tests in `rewrite.test.mjs`. |
| `hooks/markup.mjs` | Marked spans inside the reply's markdown and the Claude Code tree that draws them in colour (`toTree`); node tests in `markup.test.mjs`. |
| `hooks/links.mjs` | Pure parser and linker for work-item references (`linkify`, `repoOf`, `pickRemote`, `target`), used by `rewrite.mjs`; node tests in `links.test.mjs`. |
| `hooks/pi.mjs`, `hooks/pi-entry.mjs` | pi extension: the footer and the reply rewrites. `pi-entry.mjs` is what `package.json` loads; it adds pi-tui's OSC 8 detection, which only a static import inside pi resolves, so node tests take `pi.mjs`. |
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
- **Reply rewrites.** One pipeline (`hooks/rewrite.mjs`) rewrites the agent's reply so it is quicker to scan: links, short paths, commits, work-item states, pass/fail, masked secrets, short URLs and times, each with its own glyph and colour and each a setting. Details, settings and the runbook: [Reply rewrites](#reply-rewrites).
- **Spinner.** A `tool.call` hook records the running tool; the `Spinner` hook draws its icon and verb (` Running`, ` Searching`, ` Editing`, ` Reading`, ` Browsing`, ` Delegating`, ` Calling`) as the `message`, else the engine's own word.
- **Status line in Node, not bash.** One tested script for both CLIs, on every OS. The GCP project is read from gcloud's config files, never by running `gcloud`.
- **Copilot.** No mods API, so no band, pane or spinner ([#47](https://github.com/giocaizzi/harness/issues/47)); Copilot pipes `context_window` and `cost` to its status line, which shows `ctx N% · cache N%` with the session's hit rate and `N req` premium requests (no per-turn usage, no cache TTL, no dollars). VS Code has no status-line hook.
- **pi.** `hooks/pi.mjs` (loaded through `pi-entry.mjs`) draws the status line's parts in pi's footer (`ctx.ui.setStatus`): the context weather and percent, the model, the PR with its checks, unpushed and uncommitted work, with the same icons and forge readers (`weather.mjs`). Refreshed at session start and after each run; no band, pane, spinner or limit forecast (pi exposes no plan windows).
- **Codex, opencode.** No mods API and no status-line command, so `hud` does nothing there. Codex's `tui.status_line` takes built-in item ids only. opencode 1.19 has TUI plugins (`@opencode-ai/plugin` `tui.d.ts`: `api.slots.register` with `session_prompt_right`, `sidebar_content`, `sidebar_footer` and more), but a slot renders SolidJS/opentui JSX and the API is undocumented, so the footer is left for [#68](https://github.com/giocaizzi/harness/issues/68).

## Reply rewrites

The agent's reply is rewritten as it is drawn, with no instruction to the model. Before and after (Claude Code, defaults, in this repository's worktree):

```text
Landed #83 as e1500fb at 2026-10-13T20:56:00Z.
Edited /Users/me/code/harness/.claude/worktrees/wt/plugins/hud/hooks/mod.mjs:12 and plugins/hud/hooks/links.mjs:3:4,
see https://github.com/giocaizzi/harness/pull/84. Key: AKIAIOSFODNN7EXAMPLE

- lint: passed
- test — failed
- e2e (skipped)
```

```text
Landed  #83 as  e1500fb at  13 Oct 22:56 (1h ago).
Edited  harness[wt] › plugins/hud/hooks/mod.mjs:12 and  plugins/hud/hooks/links.mjs:3:4,
see  #84. Key:  AKIA••••••••

- lint: ✓ passed
- test — ✗ failed
- e2e (⊘ skipped)

1 ✓ · 1 ✗ · 1 ⊘
```

`#83` is purple (merged) and opens the PR, `e1500fb` is yellow and opens the commit, each path opens the editor at its line with the `harness[wt] › plugins/hud/hooks/` part dim, the name bold and `:12` peach, `#84` opens the PR, `✓ passed` is green, `✗ failed` red and `⊘ skipped` dim, the time teal with `(1h ago)` dim, and the masked key carries a lock in the warning colour.

| Setting | What it does | Glyph and colour |
|---|---|---|
| `replySecrets` | GitHub (`ghp_`, `gho_`, `ghs_`, `ghu_`, `ghr_`, `github_pat_`), Anthropic (`sk-ant-`), OpenAI (`sk-`, `sk-proj-`), AWS (`AKIA`, `ASIA`), Slack (`xox?-`) and bearer tokens keep their prefix, the rest becomes `••••••••`; a private key block keeps its BEGIN and END lines. Code spans, fenced code and URLs too, plainly. | lock (nf-fa-lock), warning colour; the mask dim |
| `replyUrls` | A bare URL, an autolink or a link labelled with its own URL gets a short label, the target kept: `owner/repo#12` (`#12` for this repository), `group/proj!4`, `site!31`, `AB#77`, `repo@e1500fb`, `repo › path:12`; any other URL over 40 characters `host/first/…/last`. A link with its own label is left. | nf-fa-github, nf-fa-gitlab, nf-cod-azure_devops, nf-fa-globe for any other host; kind colour |
| `replyRefs` | `#123`, `!45`, `owner/repo#12`, `AB#77` become links to the forge of `upstream`, else `origin` (rules below). | kind glyph and colour while the state is unknown |
| `replyState` | The reference's glyph and colour follow its state, read once per session from `gh api repos/<repo>/issues/<n>`, `glab api projects/<repo>/(issues\|merge_requests)/<n>`, `az repos pr show` or `az boards work-item show`. | open (nf-oct-issue_opened, git_pull_request) green, merged (git_merge) purple, closed (issue_closed, git_pull_request_closed) red, draft (git_pull_request_draft) grey, as GitHub draws them |
| `replyPaths` | An absolute path (POSIX, `~/`, or `C:\…`) that exists is shortened: under a repository `<repo> › <path>`, in a `.claude/worktrees/<x>` worktree `<repo>[<x>] › <path>`, under home `~/<path>`. | a file-type glyph by extension (nf-seti, nf-dev; nf-fa-folder for a folder); prefix dim, name bold |
| `replyFileLinks` | That path, or a relative `file.ext:line[:col]` resolved against the session's directory, becomes a link that opens the editor at the line; only files that exist (a folder opens `file://`). | nf-oct-code with a line; the line peach |
| `replyCommits` | 7 to 40 hex digits (with a digit and a letter) that `git cat-file -e <sha>^{commit}` finds in the session's repository link to the commit on the forge. | nf-oct-git_commit, yellow |
| `replyTimes` | An ISO-8601 time (`2026-10-13T20:56:00Z`, with or without seconds, fraction or offset) is drawn local: `13 Oct 20:56 (5h ago)`, the year added when not this one. | nf-fa-clock_o; the time teal, the relative part dim |
| `replyStatus` | A status word as a table cell, as a list item's last word after a separator (`:`, `—`, `–`, ` -`, `→`, `->`, `=`, `…`, or in parentheses) or first word when it is a symbol or upper case (`✓ lint`, `PASS lint`), or a `name: status` line: pass, passed, ok, success, ✓, ✅ → `✓`; fail, failed, error, broken, ✗, ❌ → `✗`; skipped, pending → `⊘`. A table or list with two or more gets its counts after it: `12 ✓ · 1 ✗`. Prose (`the tests passed`) is never touched. | green, red, dim |
| `glyphs`, `colour` | Turn every feature's glyph or colour off at once. | |
| `editor` | `vscode` (`vscode://file/<path>:<line>:<col>`), `cursor`, `zed`, `idea` (JetBrains `idea://open?file=…&line=…&column=…`), `sublime` (`subl://open?url=file://…`), `file` (`file://`, no line), or `custom`. | |
| `editorUrl` | The `custom` editor's URL, with `{path}` `{line}` `{col}`. | |
| `timeFormat` | `both` (`13 Oct 20:56 (5h ago)`), `absolute`, `relative`. | |

Every `reply*` setting is a picker: `on` (the default: glyph and colour as `glyphs` and `colour` say), `off`, `no-glyph`, `no-colour` or `plain` (neither). `glyphs` and `colour` default to true, `editor` to `vscode`, `timeFormat` to `both`. With `NO_COLOR` set (any non-empty value) every rewrite is plain: no glyph, no colour, links and masks still there.

Every transform but secret masking leaves fenced code (also while a reply still streams in an unclosed fence), code spans, existing markdown links and autolinks alone, and runs in the order of the table, so a later one never rewrites an earlier one's link. A lookup (a file, a `.git` above it, a commit, a state) never holds the drawing: the reply is drawn as written, and again once the answer is in, cached for the session.

How each harness draws it:

- **Claude Code.** A `ui.render` hook on `AssistantMessage`, display only: the stored message and the model keep the plain text. Markdown carries no colour and Claude Code refuses escape sequences in a rewritten reply (checked on 2.1.296), so each transform marks its spans (`markup.mjs`, Unicode noncharacters) and the hook draws the reply as a tree of its own: a line holding a marked span becomes a Text row with coloured Text and Link elements (any scheme, so `vscode://` too), a table holding one is drawn as aligned rows, and every other block stays the engine's Markdown. Colours are theme keys where the theme has one (`success`, `error`, `merged`, `inactive`, `warning`), so a light theme stays legible. A lookup that lands redraws the reply (`$.ui.invalidate`).
- **pi.** `message_end` replaces the finished message, so the session file and the model's next turn see the rewrite: the masked secret leaves the context, and every link keeps its target (full path, URL) in the markdown. Glyphs, no colour: pi's markdown takes none and an escape sequence would be stored. The message is stored once, so its lookups are waited for, at most 1.5 s. The full set runs only with a TUI and a terminal that draws OSC 8 links (pi-tui's detection); in `pi -p`, JSON or without OSC 8 only secrets are masked, plainly. `replyTimes` is off by default there: a stored `5h ago` goes stale.
- **Copilot CLI, VS Code, Codex, opencode.** No hook rewrites what a reply shows; see [#82](https://github.com/giocaizzi/harness/issues/82) and [compatibility](compatibility.md).

Work-item reference rules (`replyRefs`, `links.mjs`):

- URLs, built from the remote with no API calls: GitHub, and Enterprise hosts named `github…`, `#N` and `owner/repo#N` go to `<host>/<repo>/issues/N` (GitHub redirects a PR); GitLab `#N` to `/-/issues/N` and `!N` to `/-/merge_requests/N`, also as `group/proj#N` or `group/proj!N`; Azure DevOps `#N` and `AB#N` to `dev.azure.com/<org>/<project>/_workitems/edit/N` and `!N` to `…/_git/<repo>/pullrequest/N`. A reference the forge has no form for stays plain: `!N` and `AB#N` on GitHub, `owner/repo#N` on Azure.
- Which remote: `upstream` if it exists (in a fork the issues and PRs live on the parent), else `origin`, else the first `git remote` lists. The PR strip still reads `origin`.
- Left alone: a reference glued to a word or path (`x#1`, `a/#1`, `&#123;`, `C#7`, `github.com/o/r#1`), hex colours with letters (`#fff`, `#1a2b3c`), `#!` shebangs and `# headings`.

Known gaps: an all-digit hex colour (`#123456`) links as an issue; indented code blocks are not detected; a relative path is linked only with a line (`a.ts:3`, not `a.ts`); a path in a code span is left as written; inline markdown inside a coloured line is drawn by our row (bold, italic, code, links), so a rarer form (strikethrough, images, HTML) shows as written there.

### Configure

Claude Code: `/config`, rows `hud.replyPaths`, `hud.editor` and the rest (a change reloads the mod). Or in `~/.claude/settings.json`:

```json
{ "pluginConfigs": { "hud@giocaizzi-harness": { "options": { "editor": "cursor", "replyTimes": "off", "colour": false } } } }
```

pi: `~/.pi/agent/hud.json` (or `$PI_CODING_AGENT_DIR/hud.json`), the same keys; read at each reply, so no restart:

```json
{ "editor": "zed", "replyTimes": "on", "replyStatus": "no-glyph" }
```

Common changes:

- Open files in another editor: `editor` = `cursor`, `zed`, `idea`, `sublime` or `file`; for any other, `editor` = `custom` and `editorUrl` = e.g. `nvim://open?file={path}&line={line}`.
- No glyphs (a font without Nerd Font icons): `glyphs` = false; for one feature only, that feature = `no-glyph`.
- Monochrome: `colour` = false (Claude Code then hands the engine plain markdown again), or set `NO_COLOR`.
- Turn one rewrite off: that feature = `off`.

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

Reply rewrites, live: in a repository with a GitHub, GitLab or Azure DevOps remote, ask the agent to "reply with exactly" the before text under [Reply rewrites](#reply-rewrites), with a path, a commit and an issue of that repository. Claude Code (with hud installed, or `claude --plugin-dir plugins/hud`) and pi (in a terminal that takes OSC 8 links, such as Ghostty, iTerm2, WezTerm or kitty; inside tmux only with the `hyperlinks` terminal feature on an attached client) draw the after text: each reference, commit, path and URL an OSC 8 link, the statuses and their counts, the masked key. pi needs no login for this: point a `models.json` at a scripted Chat Completions server, as `tests/e2e/mock-llm.mjs` does. Checked on 2026-10-14 through a pseudo-terminal: Claude Code 2.1.296 drew `#83` first in the issue colour, then purple with the merged glyph once `gh` answered, `vscode://file/…/mod.mjs:12:1` around `harness[agent-…] › plugins/hud/hooks/mod.mjs:12`, the commit link, the statuses in the theme's `success` and `error` colours, a drawn table and `AKIA••••••••`; pi 1.2.0 drew the same links (`vscode://` too), glyphs (the merged one included) and masks, without colour.

In a live Claude session the band shows the cache and TTL after the first turn and the sparkline after two; `/weather` opens the pane; the spinner names a running tool. In Copilot CLI the status line shows `ctx N%` at once and `cache N%` after the first turn.
