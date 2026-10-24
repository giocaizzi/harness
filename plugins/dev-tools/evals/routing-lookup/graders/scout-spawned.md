---
type: tool_used
tool: Agent
input_match: '"subagent_type"\s*:\s*"(?:dev-tools:)?scout"'
---

A lookup that follows call chains across files goes to scout, not to the driver, a general-purpose spawn or the built-in Explore agent.
