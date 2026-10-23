---
name: wt
description: Start a task in its own git worktree and branch, from an issue number or a slug. Use when the user asks to start work on a task or issue, or types /wt <issue-or-slug>.
---

# Worktree

Argument: a GitHub issue number or a short slug. The argument is the text after the skill name, repeated here when the harness fills it in: $ARGUMENTS

There is no fixed cap on worktrees or agents; throttle on availability instead. Heavy repos make each worktree costly, so reuse before creating.

1. **Look first:** `git worktree list`. Remove finished ones with plain `git worktree remove <path>`, never `--force`, then `prune`; if it refuses, report what is left in that worktree and stop. Check your plan quota before starting more parallel work (the per-harness commands are in `host-hygiene`) and back off near the session or weekly limit.
2. **Branch name:** `<type>/<slug>`; for an issue, take the title from `gh issue view <n>` and include the number.
3. **Create** from the up-to-date default branch: `git fetch`, then `git worktree add .claude/worktrees/<slug> -b <branch> origin/<default>`. Worktrees live in the repo's own `.claude/worktrees/`, never beside the repo, unless the repo's `AGENTS.md` names another location: follow it. That exception exists for repos whose tooling reads the whole checkout, nested copies included (e.g. a dotfiles manager that would apply a worktree's half-finished data). If the repo's `.gitignore` lacks the `.claude/worktrees/` entry, add it (the `repo-standard` agent-config block): a global excludes file covers only this machine.
4. **Switch into it.** Install dependencies only if the task needs them.

Report the path and branch. Remove the worktree when its PR merges (`land` does this).
