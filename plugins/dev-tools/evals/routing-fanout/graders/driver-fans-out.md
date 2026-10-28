---
type: regex
target: trace
pattern: '"subagent_type":"(?:dev-tools:)?worker"[^\n]*"parent_tool_use_id":"toolu'
---

The driver spawns at least one `worker` itself: a worker spawn inside a subagent's turn (it carries the driver's `parent_tool_use_id`), so the exporters are written by workers rather than by the driver.
