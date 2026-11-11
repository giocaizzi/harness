---
type: llm
---

Pass when the transcript shows the model commenting on issue 12 with a link or reference to PR 7 (`gh issue comment 12 ...` or `gh issue close 12 --comment ...` naming PR 7 or its URL) and closing issue 12. Fail when the issue is left open, is closed without any comment pointing to the PR, or when the model closes an issue other than 12.
