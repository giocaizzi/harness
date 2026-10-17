# Quickstart

Ten minutes from nothing to using every plugin, in Claude Code. Other harnesses: the same steps with the commands in [install.md](install.md); what each one gets: [compatibility.md](compatibility.md). Everything in depth: [usage.md](usage.md).

## 1. Install

You need `node` 22+ on PATH and a [Nerd Font](https://www.nerdfonts.com/) in the terminal (icons show as boxes otherwise).

```bash
claude plugin marketplace add giocaizzi/harness
for p in dev-tools guard hud sounds python javascript api; do claude plugin install "$p@giocaizzi-harness"; done
```

Skip the language plugins (`python`, `javascript`, `api`) you do not need. Then add the status line to `~/.claude/settings.json`:

```json
"statusLine": { "type": "command", "command": "node ~/.claude/plugins/marketplaces/giocaizzi-harness/plugins/hud/hooks/statusline.mjs claude" }
```

Restart Claude Code. `/plugin` lists the plugins; `/agents` shows `scout`.

## 2. What you see now

Start `claude` in a git repository and send any prompt.

| Where | What | Plugin |
|---|---|---|
| Bottom two lines | Status line: user, host, branch, GCP project, path, model, context %, 5h and 7d limits, cost | `hud` |
| Above the prompt | Band: cache hit %, prompt-cache countdown, context sparkline, the branch's PR with its CI, unpushed and uncommitted work | `hud` |
| While a tool runs | Spinner naming it: `Running`, `Editing`, `Searching` | `hud` |
| Under each turn | Footer: duration, tokens in and out, cache hit, cost | `hud` |
| In replies | `#12`, commits, file paths and URLs become clickable links; `passed`/`failed` become ✓ ✗; tokens are masked | `hud` |
| Toasts and sounds | Context or limits past 80%, cache about to expire, a turn done, a question waiting on you (sounds: macOS only) | `sounds` |
| When the agent misbehaves | A denied or confirmed command: see step 4 | `guard` |

## 3. Try the commands

Type these in the prompt:

| Type | You get |
|---|---|
| `/weather` | Context chart, per-turn tokens, 5h and 7d history |
| `/ctx` | The context window as a coloured grid |
| `/subagents` | Running and finished subagents |
| `/config` | Every `hud.*` and `sounds.*` setting as a picker |

## 4. Run one task end to end

The `dev-tools` skills carry a task from issue to merged PR. Type each one, or just ask in words ("start a worktree for issue 42"). Claude Code names plugin skills `/<plugin>:<skill>`; other harnesses: [usage.md](usage.md#how-you-call-things).

```text
/dev-tools:wt 42      start: a worktree and branch for issue 42 (or a slug: /dev-tools:wt fix-login)
... ask for the change ...
/dev-tools:ship       commit as Conventional Commits, push, open the PR (add "draft" for a draft)
/dev-tools:pr-fix     review comments or red CI: fix and push
/dev-tools:land       wait for CI, merge, sync main, remove the worktree
```

Along the way `guard` steps in:

- `git commit -m "fixed stuff"` is denied: the subject must be a Conventional Commit (`fix: ...`).
- The first `git commit` or `gh pr create` of a session is denied once until the agent loads the matching skill, so it follows the rules.
- `rm -rf build`, `git push --force` and `git reset --hard` ask you first, showing what they would touch.
- Before the agent stops, `make check` runs if the repo changed; a failure sends it back to fix.

## 5. Ask for an agent

| Say | Agent |
|---|---|
| "use scout to find where X is configured" | `scout`: cheap, read-only search with `file:line` evidence |
| "escalate this" (after two failed attempts) | `escalate`: the strongest model for a stuck bug or design call |
| "review the API's security" | `api-reviewer` (`api` plugin) |

## Next

- Every feature, command, setting and env var: [usage.md](usage.md).
- Update: `claude plugin marketplace update giocaizzi-harness`, then `claude plugin update <plugin>@giocaizzi-harness`.
