---
type: tool_used
tool: Agent
input_match: '^(?=[\s\S]*"subagent_type"\s*:\s*"(?:dev-tools:)?reviewer")(?=[\s\S]*"model"\s*:\s*"opus")(?=[\s\S]*"effort"\s*:\s*"high")'
---

A sensitive review (security or auth, secrets, kill switch, merge or release gates, protected paths, a large change or a core process) spawns the `reviewer` with `model: opus` and `effort: high` on the spawn.
