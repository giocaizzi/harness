---
name: ticket-run
description: Work one owner-approved GitHub issue end to end, attended - check the approval, post a plan, decide scope with the fold-in test and log it on the ticket, ask questions on the ticket, verify with a fresh-context verifier, ship, deploy, live-verify and record the result. Use when the user asks to work, run, pick up, finish or resume a ticket or issue, or types /ticket-run (with an issue number), in a repo that has a .factory/config.yaml.
---

# Ticket run

One ticket, from approval to merged, deployed and verified work. The owner chose *which* ticket; you own *everything it needs to be done*, and nothing else. The argument is the issue number or URL; it is the text after the skill name, repeated here when the harness fills it in: $ARGUMENTS

The repo's `.factory/config.yaml` holds what is particular to it: approvers, label names, the marker, components with their checks and deploys, risk tiers. Without one, stop and point to `docs/adopt-factory.md` in giocaizzi/harness; `docs/factory.md` there explains the protocol.

**Done means** the whole scope is merged in one PR that closes the ticket, the deploy and live checks passed where the component deploys, and the evidence and result are on the ticket. **Stop and ask on the ticket** only when you cannot continue without the owner, or before anything destructive.

## The run

1. **Gate:** open, approval label on, applied by an approver per the issue timeline ([comments.md](references/comments.md#gate)).
2. **Resume** a parked ticket only on an approver's answer ([comments.md](references/comments.md#answers)).
3. **Plan comment** first. XS and S start right after it; M and larger wait for the owner's OK.
4. **Work** in a worktree (`wt`). Decide what belongs to the ticket with the [fold-in test](references/fold-in-test.md), and log every call.
5. **Questions** go on the ticket and park it ([comments.md](references/comments.md#questions-and-parking)).
6. **Finish:** verifier, ship, land, deploy, record ([done.md](references/done.md)).

## Firm rules

- Proceed only past the gate; never add the approval label.
- Never close, re-scope or mark an issue not planned; only your own PR's `Closes #N` closes the ticket.
- No partial PRs: one PR with the whole scope, never a `Refs`-only PR for the ticket.
- Every comment and issue you write starts with the marker, or it reads as the owner's.

## Output

Every run ends with the result comment and `result.json` ([done.md](references/done.md#record)), then this report:

- **End state:** `done`, `parked` or `failed`, with the ticket and PR links.
- **Blocked on me:** the open question or owner action, or "nothing".
- **Changed:** what merged, deployed and was verified.
- **Found:** decision-log rows other than plain fold-ins, and follow-up issues.
