---
type: tool_used
tool: Agent
input_match: '^(?=[\s\S]*"subagent_type"\s*:\s*"(?:dev-tools:)?reviewer")(?=[\s\S]*"(?:model|effort)"\s*:)'
min: 0
max: 0
---

A routine review runs the `reviewer` at its own routine tier: the spawn carries no `model` or `effort`.
