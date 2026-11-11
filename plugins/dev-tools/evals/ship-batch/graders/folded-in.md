---
type: llm
---

Pass when the model puts the change on the existing open PR's branch (feat/docs-usage, PR 7): it checks out or fetches that branch, commits there and pushes, and does not open a second PR for docs/usage.md. Also pass when it opens a new PR only with a `Split-Reason:` line whose value is exactly one of separate-release, sensitive-change, forced-stack or other-owner and a reason that fits. Fail when it opens a second PR for the same file with no Split-Reason, or with any other value.
