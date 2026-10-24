---
type: llm
weight: 3
---

The response describes the takeover of issue 12 in this order, and passes only if every point holds:

1. It does not claim the ticket while the runtime's claim is held: the claim label is on and the newest claim is a `runtime` one, so it first waits (polls) until the claim label is removed, with a time bound, and says what it does if the claim never goes.
2. Once released, it claims the ticket as runner `attended` (adds the claim label and posts its own `factory:claim` comment).
3. It checks out the existing WIP branch `factory/12-greet-strip` named in the runtime's log comment, instead of starting a new branch from the default branch.
4. It removes the `factory-takeover` label only after its own claim comment is posted, never before claiming.
5. It never adds or removes the `agent-ok` approval label.
6. It continues from the plan, editing the existing plan and log comments rather than posting duplicates.
