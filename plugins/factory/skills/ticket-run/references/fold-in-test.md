# The fold-in test

Apply it to anything you find while working: a bug, a missing migration, a stale doc, a broken neighbouring test, a refactor idea. It exists to stop two failures at once: doing more than the ticket (unasked refactors, self-chosen work) and doing less (follow-up issues for what the ticket needed, partial PRs).

## Step 1: is it in scope?

Yes if any holds:

- **R1 Required.** An acceptance check or the repo's checks cannot pass without it, including bugs that block the ticket.
- **R2 Side effect.** A consequence of the change itself: tests, migration, docs or runbook, regenerated types or clients, config and flags, deploy, live verification. Always in, no decision needed.
- **R3 Entangled.** On the same code path the ticket changes, or caused or exposed by this change, so fixing it later would mean reworking this change.

None holds: it is **separate** (below).

## Step 2: may you fold it in alone?

R1 and R2 items are must-haves: always in, no decision needed. Any other in-scope item is folded in alone only if all hold:

- **L1** it stays in the ticket's component (config `components`);
- **L2** the ticket grows by at most one size step (XS→S, S→M; M stays M);
- **L3** it does not raise the risk tier (config `risk`);
- **L4** it needs no owner or product decision: no behaviour beyond the acceptance criteria, no public API or data-contract change, no data deletion, no new cost or dependency, no weaker security.

Otherwise ask on the ticket.

| Step 1 | Step 2 | Do |
|---|---|---|
| R1 or R2 | | fold in; log it only if the plan does not already cover it (see Decision log) |
| R3 | L1-L4 hold | fold in, log it |
| R3 | any fails | ask on the ticket, logging which `L` failed |
| separate | | don't touch it; handle as separate work |

Never in the diff: "while I'm here" refactors, style changes outside the lines you touch, work that belongs to another open issue (comment a cross-link there instead).

## Decision log

Log only calls the approved plan does not already cover. A row is for a fold-in (an R1 or R3 item beyond the plan), a question, a note, or a filed or commented follow-up. No row for:

- a hunk that traces to an acceptance check in the plan: the verifier traces it to the `AC<n>`;
- an R2 side effect the plan's "side effects in scope" already names.

One row per item: what, where you found it, which test (`R1`, `R2`, `R3`, `separate`; add the failing `L` when you asked), the decision (`folded`, `asked`, `noted`, `filed`, `commented`) and where it landed (commit, question, issue or comment). The verifier traces every changed hunk to an acceptance check, a row, or the PR's "Existing tests changed" line ([done.md](done.md#ship-and-land)); a hunk that traces to none of them fails the gate.

## Separate work

1. Search for an issue that already covers it: `gh issue list --state open --search "<terms>"`.
2. Prefer a comment on that issue adding the evidence or scope (marker first).
3. Open a new issue only when nothing covers it, with the marker first in the body, grouping related findings into one issue instead of one per finding. Put it in the backlog (the board's backlog status, if any). Never add the approval label: you never approve work.
4. Log it as `commented` or `filed` with the link; it goes to `follow_ups` in the result.

Nits and refactor wishes are not separate work: log them as `noted` or drop them.
