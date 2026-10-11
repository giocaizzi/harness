---
name: land
description: Wait for CI on a PR, fix trivial failures, merge it through auto-merge or the merge queue, then sync main and remove the branch and worktree. Use when the user asks to merge or land a PR, or types /land (optionally a PR number).
---

# Land

Take an open PR to merged and clean. Argument (`$ARGUMENTS`): a PR number; default is the current branch's PR. Follow `github-workflow` for the rules.

1. **Watch CI:** `gh pr checks --watch`. On failure, fix lint or format problems with a new commit and push; for anything else, stop and report the failing job and its log.
2. **Merge without bypassing:** `gh pr merge --auto --squash` (or enqueue when a merge queue exists). Never use `--admin` or disable a rule.
3. **Keep stacked children alive:** if other PRs are based on this branch, do not delete it (`gh pr list --base <branch>`); GitHub closes PRs whose base disappears. Retarget them first.
4. **Wait until merged**, then `git pull --ff-only` on the default branch.
5. **Clean up:** delete the local branch, `git worktree remove` this task's worktree, `git worktree prune`.

Report the merge commit and anything left behind.
