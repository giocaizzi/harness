---
name: wt
description: Start a task in its own git worktree and branch, from an issue number or a slug, respecting the cap on live worktrees. Invoke explicitly as /wt <issue-or-slug>.
disable-model-invocation: true
---

# Worktree

Argument (`$ARGUMENTS`): a GitHub issue number or a short slug.

Each live worktree costs disk, watchers and CPU, and heavy repos make it worse, so reuse before creating.

1. **Count first:** `git worktree list`. At two live worktrees, stop and ask which to remove (finished ones: `git worktree remove`, then `prune`).
2. **Branch name:** `<type>/<slug>`; for an issue, take the title from `gh issue view <n>` and include the number.
3. **Create** from the up-to-date default branch: `git fetch`, then `git worktree add <path> -b <branch> origin/<default>`.
4. **Switch into it.** Install dependencies only if the task needs them.

Report the path and branch. Remove the worktree when its PR merges (`land` does this).
