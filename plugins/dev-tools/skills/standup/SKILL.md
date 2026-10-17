---
name: standup
description: Terse status of the current work - what is done (merged PRs with SHAs, releases, deploys), what is in flight (open PRs and CI, running subagents or peer sessions), what waits on the user, and leftovers (worktrees, branches, temp files). Use when the user asks for a recap, status, summary or "where are we", or types /standup.
---

# Standup

Answer "where are we" in one screen. Argument: an optional scope, such as a repo, PR or topic; default is everything this session touched. The argument is the text after the skill name, repeated here when the harness fills it in: $ARGUMENTS

Gather, read-only:

- The conversation: what was asked, done, decided and promised.
- `git worktree list` and `git branch -vv` in each repo touched.
- The forge: `gh pr list --author @me --state all --limit 20 --json number,title,state,mergeCommit,headRefName` and `gh pr checks <n>` for open ones (other forges: `repo-standard`). Releases and deploys only when the work produced them (`gh release list`, the deploy run's status).
- Running agents: the harness's own listing where it has one (Claude Code `ListAgents`, background tasks); per harness: `subagent-orchestration`. Never claim a result that has not been reported.

Output: four short sections, rows not prose, each item one line with its link, SHA or path. Leave a section out when it is empty.

| Section | One line per |
|---|---|
| Done | merged PR (`#n` title, merge SHA), release (tag), deploy (where, verified or not) |
| In flight | open PR (`#n`, CI green/red/pending, blocked on), running agent or peer session and its task |
| Needs you | decision, approval, command only the user can run, failing check needing a call |
| Leftovers | worktree or branch whose PR merged, stale temp file, unpushed commit |

No narration, no plan, no repeated history. Never print a private value (tokens, internal hostnames, account IDs); name the secret, not its content.
