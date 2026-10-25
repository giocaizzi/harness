# Resume after a network or host drop

**When:** the network or the host dropped (sleep, reboot, Wi-Fi loss) while sessions, teammates or waits were running. Not for a single failed command.
**Preconditions:** a shell in the repo, `gh` installed. Session listing is per harness; the table is in [collaboration.md](collaboration.md#by-harness).

## Steps
1. **Confirm the network and the forge login.** `gh auth status` must report a logged-in account; a token that expired during the drop makes every later check fail in a confusing way.
2. **List sessions and teammates.** Claude Code: `ListAgents`. Other harnesses: the "List and message other sessions" row of the By harness table in [collaboration.md](collaboration.md#by-harness) (Copilot CLI and pi cannot list other sessions; Codex through `codex agents`; opencode through its `opencode serve` HTTP API). A teammate that shows as running but has produced nothing since the drop is treated as lost.
3. **Check each PR and its CI before resuming anything.** `gh pr view <n> --json state,mergeStateStatus,statusCheckRollup`, or `${CLAUDE_PLUGIN_ROOT}/skills/land/scripts/wait-pr.sh <n> --timeout <s>` (unrendered: `scripts/` under the path the `land` skill was loaded from; `.ps1` on Windows), which returns at once if the PR already ended. A PR may have merged, failed a check or fallen behind while nobody watched.
4. **Check worktrees and unpushed work.** `git worktree list`, then, for each listed path, `git -C <path> status -sb` (uncommitted changes, branch and upstream) and `git -C <path> log HEAD --branches --not --remotes --oneline` (commits on that worktree's HEAD or any local branch that no remote has; unlike `git log @{u}..` it works on a never-pushed branch, and `HEAD` is what covers a detached worktree, as reviewer and verifier worktrees are). Commit and push what the drop left behind before a resumed agent touches it. A detached HEAD cannot be pushed as is: push it to a branch (`git push origin HEAD:refs/heads/<name>`) or note its commit.
5. **Resume in order, staggered.** Land PRs that already pass first, then resume sessions that block others, then the rest. Start them a few minutes apart so the burst does not hit the plan quota at once (`host-hygiene` for load and quota).
6. **Re-arm every wait with its deadline inside the command** (`wait-pr --timeout`, or a loop that counts its polls), as in `subagent-orchestration` (Waiting on other agents). A wait from before the drop is gone, whatever the session shows.

## Verify
Each resumed session has reported progress, each PR you track has a state you read in step 3, `git status -sb` shows a clean tree in every worktree, and the `git log HEAD --branches --not --remotes --oneline` of step 4 prints nothing in each. Empty output in every worktree means every commit reachable from a local branch or a worktree's HEAD is on a remote; an error (`fatal: ...`) means the check did not run, so it proves nothing.

## Rollback
Steps 1 to 3 and 5 to 6 only read state or start waits. Step 4 may commit and push: undo it with `git revert` or by deleting the pushed branch.

**Last verified:** 2026-10-25 by the author, `ListAgents` and the `gh` and `git` commands only; other harnesses not checked.
