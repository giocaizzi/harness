---
name: wt
description: Start a task in its own git worktree and branch, from an issue number or a slug. Use when the user asks to start work on a task or issue, or types /wt <issue-or-slug>.
---

# Worktree

Argument (`$ARGUMENTS`, or the text after the skill name where that placeholder is left as is): a GitHub issue number or a short slug.

There is no fixed cap on worktrees or agents; throttle on availability instead. Heavy repos make each worktree costly, so reuse before creating.

1. **Look first:** `git worktree list`. Remove finished ones (`git worktree remove`, then `prune`). Check your plan quota before starting more parallel work (the per-harness commands are in `host-hygiene`) and back off near the session or weekly limit.
2. **Branch name:** `<type>/<slug>`; for an issue, take the title from `gh issue view <n>` and include the number.
3. **Create** from the up-to-date default branch: `git fetch`, then `git worktree add .claude/worktrees/<slug> -b <branch> origin/<default>`. Worktrees always live in the repo's own `.claude/worktrees/`, never beside the repo. If the repo's `.gitignore` lacks that entry, add it (the `repo-standard` agent-config block): a global excludes file covers only this machine.
4. **Switch into it.** Install dependencies only if the task needs them.

Report the path and branch. Remove the worktree when its PR merges (`land` does this).
