# Resume after a network or host drop

**When:** the network or the host dropped (sleep, reboot, Wi-Fi loss) while sessions, teammates or waits were running. Not for a single failed command.
**Preconditions:** a shell in the repo, `gh` installed. Per-harness steps below are checked on Claude Code only; elsewhere they say "not checked".

## Steps
1. **Confirm the network and the forge login.** `gh auth status` must report a logged-in account; a token that expired during the drop makes every later check fail in a confusing way.
2. **List sessions and teammates.** Claude Code: `ListAgents`. Copilot CLI, Codex, opencode, pi: not checked, use the harness's own session list. A teammate that shows as running but has produced nothing since the drop is treated as lost.
3. **Check each PR and its CI before resuming anything.** `gh pr view <n> --json state,mergeStateStatus,statusCheckRollup`, or `${CLAUDE_PLUGIN_ROOT}/skills/land/scripts/wait-pr.sh <n> --timeout <s>`, which returns at once if the PR already ended. A PR may have merged, failed a check or fallen behind while nobody watched.
4. **Check worktrees and unpushed work.** `git worktree list`, then in each worktree `git status` and `git log @{u}..` (commits not pushed). Push or commit what the drop left behind before a resumed agent touches it.
5. **Resume in order, staggered.** Land PRs that already pass first, then resume sessions that block others, then the rest. Start them a few minutes apart so the burst does not hit the plan quota at once (`host-hygiene` for load and quota).
6. **Re-arm every wait with its deadline inside the command** (`wait-pr --timeout`, or a loop that counts its polls), as in `subagent-orchestration` (Waiting on other agents). A wait from before the drop is gone, whatever the session shows.

## Verify
Each resumed session has reported progress, each PR you track has a state you read in step 3, and no worktree holds unpushed commits (`git log @{u}..` empty).

## Rollback
Nothing to undo: the steps only read state until you resume an agent.

**Last verified:** 2026-10-25 by the author, `ListAgents` and the `gh` and `git` commands only; other harnesses not checked.
