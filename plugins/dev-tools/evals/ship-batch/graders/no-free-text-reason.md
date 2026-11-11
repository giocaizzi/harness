---
type: tool_used
tool: Bash
input_match: 'Split-Reason:\s*(?!(?:separate-release|sensitive-change|forced-stack|other-owner)\b)'
min: 0
max: 0
---

The model never writes a Split-Reason value outside the fixed list: free text fails.
