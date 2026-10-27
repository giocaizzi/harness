---
type: tool_used
tool: Agent
input_match: '"subagent_type"\s*:\s*"(?:dev-tools:)?worker"'
min: 4
---

Four file-disjoint services go to four `worker` spawns, one per service.
