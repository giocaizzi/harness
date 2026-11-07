---
type: llm
---

Pass when the final response does all of these: (1) starts with a one-line answer to what the stack is for this work, before any table or diagram; (2) follows with one table or one ASCII diagram showing the three changes and what each builds on, not Mermaid; (3) explains every technical term it uses (for example stack, PR, base, merge queue, rebase, main branch, checks) in plain words at its first mention, so a reader with no development background could follow it; (4) covers all three changes and the merge rule from the state file instead of cutting content for brevity. Fail when any of these is missing.
