---
name: standup
description: "Use when the user asks for a recap, status, progress, where things stand, what is left or what they need to decide ('what do you need from me?'), or for the work in simpler words; /standup [detail|explain]."
---

# Standup

Turn "where are we" into one fixed report for the owner. Arguments, after the skill name (the harness fills them in here): `[scope]` (a repo, PR or topic; default is everything this session touched), `detail`, `explain <topic>`. Arguments: $ARGUMENTS

Gather, read-only:

- The conversation: what was asked, done, decided and promised.
- `git worktree list` and `git branch -vv` in each repo touched.
- The forge: `gh pr list --author @me --state all --limit 20 --json number,title,state,mergeCommit,headRefName` and `gh pr checks <n>` for open ones (other forges: `repo-standard`). Releases and deploys only when the work produced them (`gh release list`, the deploy run's status).
- Running agents: the harness's own listing where it has one (Claude Code `ListAgents`, background tasks); per harness: `subagent-orchestration`. Never claim a result that has not been reported.

## Report

In this order:

1. **Story**, three lines: `Goal:`, `Where we are:` with a count ("3 of 5 changes merged"), `Next:`.
2. **Needs you**, numbered, right after the story. Each item in plain words: the action, what happens if yes, the recommended option. PR numbers and SHAs go at the end of the line, shown only with `detail`. Leftover cleanup (merged worktrees and branches, stale temp files) is an item here, so `all` covers it. Close with: "Reply `all` to take every recommendation, `all but 2`, or a number with your choice." An item with no recommendation is marked "needs your choice".
3. **Done / In flight** as one table or a tree. Done shows at most 5 rows, then "and N more".
4. **Leftovers** only under `detail`.

Every technical term gets a one-line gloss at its first mention: `references/GLOSSARY.md`. Pick tables, decision trees and ASCII diagrams by the shape of the content: `references/FORMS.md`. Mermaid only when asked (it does not render in a terminal).

## `explain <topic>`

Explains one part of the current work. The answer in one line first, then one table or ASCII diagram, with no unexplained term. Completeness beats the Concise output style's brevity in this mode only; handle length with structure (rows, short headed blocks), not by cutting content. A general concept question outside the current work stays ordinary chat.

## Gotchas

- A count without a denominator says nothing: "3 of 5", not "3 merged".
- An item with no recommendation cannot be approved by `all`: give one or mark it "needs your choice".
- hud rewrites `#n` into links, so refs stay at the end of the line, never at its start.
- A long Done list buries Needs you: cap it.
- Never print a private value (tokens, internal hostnames, account IDs); name the secret, not its content.

## Not this skill

`ship` and `land` act; standup only reports. After "all", acting on the approved items is the session's normal routing. `subagent-orchestration` owns routing and the relay of agent reports; `docs-sync` owns docs; hud owns rendering.
