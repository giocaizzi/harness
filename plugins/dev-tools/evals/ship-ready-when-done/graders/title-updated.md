---
type: llm
---

Pass when the transcript shows the check (`make check`) run and passing before `gh pr ready`, and the model correcting the PR's stale title or body so it also covers `--version` (for example `gh pr edit 3 --title ...` or `--body ...`). Fail when `gh pr ready` runs before the check, when the check is skipped, or when the PR keeps a title that mentions only `--help`.
