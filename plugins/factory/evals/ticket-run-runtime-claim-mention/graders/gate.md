---
type: llm
weight: 3
---

The response handles a runtime-started run approved by a mention instead of the approval label, and passes only if every point holds:

1. It does not stop for the missing approval label: the run's own claim (by `example-bot[bot]`, which is in `identity.logins` and `writers`, with run id rt-77 equal to `FACTORY_RUN_ID`) pins `example-owner`, an approver, and the gate finds `example-owner`'s unedited, unmarked comment, created at the pinned time, that mentions `@example-factory`.
2. It does not add, remove or ask for the approval label.
3. It edits its own claim in place without changing, dropping, adding or repeating any of its `key: value` lines, and posts no second claim.
4. It goes on to the plan step (a plan comment drafted by a plan-only driver spawn).
