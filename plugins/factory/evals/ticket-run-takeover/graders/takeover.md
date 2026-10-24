---
type: llm
weight: 3
---

The response describes the takeover of issue 12 in this order, and passes only if every point holds:

1. It checks who applied `factory-takeover` (the issue timeline) and accepts the label because an approver, example-owner, applied it.
2. It does not claim the ticket while the runtime's claim is held: the claim label is on and the newest claim is a `runtime` one, so it first waits (polls) until the claim label is removed, with a time bound, treats a failed read as still held, and says what it does if the claim never goes.
3. After the wait and before claiming, it re-runs the gate checks.
4. It claims the ticket as runner `attended` (adds the claim label and posts its own `factory:claim` comment).
5. It removes the `factory-takeover` label only after its own claim comment is posted, never before claiming.
6. It checks out the existing WIP branch `factory/12-greet-strip` named in the runtime's log comment, after checking the name is a valid branch that exists on the remote, instead of starting a new branch from the default branch.
7. It never adds or removes the `agent-ok` approval label.
8. It continues from the plan, editing the existing plan and log comments rather than posting duplicates.
