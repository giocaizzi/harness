---
name: wt
description: "Use at the start of any new task, issue or feature, before touching code: \"pick up #57\", \"let's start on issue 34\", \"new task: add rate limiting to the API\". Starts the task in its own git worktree and branch, from an issue number or a slug. Also when the user types /wt [issue-or-slug]."
---

# Worktree

Argument: a GitHub issue number or a short slug. A task can be a batch of related issues that land in one PR (`github-pull-requests`): one worktree and branch for the whole batch. The argument is the text after the skill name, repeated here when the harness fills it in: $ARGUMENTS

There is no fixed cap on worktrees or agents; throttle on availability instead. Heavy repos make each worktree costly, so reuse before creating.

1. **Look first:** `git worktree list`. A worktree whose branch origin already holds is disposable (`github-pull-requests`, Branch lifecycle): remove it with plain `git worktree remove <path>`, never `--force`, then `prune`; if it refuses, report what is left and stop. Over about 10 worktrees, run `host-hygiene`'s `repo-sweep` (dry run) and show the owner its summary. Check your plan quota before starting more parallel work (the per-harness commands are in `host-hygiene`) and back off near the session or weekly limit.
2. **Branch name:** `<type>/<slug>`; for an issue, take the title from `gh issue view <n>` and include the number.
3. **Create** from the up-to-date default branch, at the main checkout's root, never inside a linked worktree: `git fetch`, then `git worktree add "$(git rev-parse --path-format=absolute --git-common-dir)/../.claude/worktrees/<slug>" -b <branch> origin/<default>` (PowerShell: the same with `$(...)` as a subexpression). Worktrees live in the repo's own `.claude/worktrees/`, never beside the repo, unless the repo's `AGENTS.md` names another location: follow it. That exception exists for repos whose tooling reads the whole checkout, nested copies included (e.g. a dotfiles manager that would apply a worktree's half-finished data). If the repo's `.gitignore` lacks the `.claude/worktrees/` entry, add it (the `repo-standard` agent-config block): a global excludes file covers only this machine. A repo whose `AGENTS.md` allows direct commits to the default branch: a single agent works in the main checkout on the default branch; parallel agents each still get a worktree.
4. **Switch into it.** Install dependencies only if the task needs them; they come from the per-user shared stores, and tools are never installed into the worktree (`host-hygiene`, Shared stores).

Report the path and branch. From the first commit, push every commit and open the draft PR (`ship`); `land` removes the worktree after the merge.
