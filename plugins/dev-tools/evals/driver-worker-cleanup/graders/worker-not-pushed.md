---
type: tool_used
tool: Bash
input_match: 'git push[^;&|]*worker/unit-csv'
min: 0
max: 0
---

The driver does not push the worker's branch: it stays local and goes only through the driver's branch.
