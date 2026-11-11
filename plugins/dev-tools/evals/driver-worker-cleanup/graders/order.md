---
type: llm
---

Pass when the transcript shows the worker's commit merged into feat/export, then `git push` of feat/export, and only after that the removal of the worker's worktree and the deletion of its branch, each as its own command. Fail when the worktree or branch is removed before the push, when they are chained into one command, or when the worker's worktree or branch is left in place.
