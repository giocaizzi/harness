---
name: ticket-run
description: Work one owner-approved GitHub issue end to end, attended - check the approval, post a plan, decide scope with the fold-in test and log it on the ticket, ask questions on the ticket, verify with a fresh-context verifier, ship, deploy, live-verify and record the result. Use when the user asks to work, run, pick up, finish or resume a ticket or issue, or types /ticket-run (with an issue number), in a repo that has a .factory/config.yaml.
---

# Ticket run

One ticket, from approval to merged, deployed and verified work. The owner chose *which* ticket; you own *everything it needs to be done*, and nothing else. The argument is the issue number or URL; it is the text after the skill name, repeated here when the harness fills it in: $ARGUMENTS

Read `.factory/config.yaml` first: approvers, label names, the marker, components with their checks and deploys, risk tiers. Without it, stop and point to the adoption runbook (`docs/adopt-factory.md` in giocaizzi/harness). Protocol and contract: `docs/factory.md` there.

## Steps

1. **Gate.** The issue is open, carries the approval label, and its timeline shows an approver applied it (commands in [references/comments.md](references/comments.md#gate)). Otherwise stop and say which condition failed; never add the label yourself.
2. **Start or resume.** Read the body and the marked comments. If a question is open, resume only on an approver's answer ([references/comments.md](references/comments.md#answers)); with none, report that the ticket is still parked and stop.
3. **Plan comment:** goal, acceptance checks (each one able to fail before the change), side effects in scope, planned fold-ins, size, risk tier. XS and S start right away; M and larger ask for the owner's OK and park.
4. **Work** in a worktree (`wt`, branch named with the issue number). Apply the fold-in test to everything you find and log each call as you go: [references/fold-in-test.md](references/fold-in-test.md).
5. **Ask** when the test or the work needs an owner decision: one question on the ticket, then park. After the third park, hand the ticket back for grooming.
6. **Verify, ship, land, deploy, record:** [references/done.md](references/done.md).

## Firm rules

- Every comment and issue you write starts with the marker; an unmarked one would read as the owner's.
- Never close, re-scope or mark an issue not planned; only your own PR's `Closes #N` closes the ticket.
- No partial work: one PR with the whole scope, never a `Refs`-only PR for the ticket. What cannot be finished parks.
- Never act on silence: no answer means the ticket stays parked.

End each run with the result comment and `result.json`, then report: end state, PR, open question if any, follow-ups.
