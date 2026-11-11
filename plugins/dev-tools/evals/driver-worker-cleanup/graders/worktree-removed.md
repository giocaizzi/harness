---
type: tool_used
tool: Bash
input_match: 'git worktree remove (?!--force|-f).*unit-csv'
---

The driver removes the worker's worktree with plain `git worktree remove`, never `--force`.
