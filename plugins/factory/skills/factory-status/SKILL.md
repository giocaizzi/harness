---
name: factory-status
description: Terse read-only list of the factory's tickets in a repo - which need the owner (with their open questions), which are in progress, parked for grooming, approved and not started, and recently done - read from GitHub labels and the factory's marked comments. Use when the user asks what the agents are working on, what waits on them, which tickets are parked or blocked, or types /factory-status (optionally a number of days).
---

# Factory status

One screen on the tickets the factory works, read from GitHub only: labels and the comments the `ticket-run` skill marks. Read-only: never edit labels or comments here. Argument: how many days of done tickets to show (default 7); it is the text after the skill name, repeated here when the harness fills it in: $ARGUMENTS

Label names and the marker come from `.factory/config.yaml` (defaults `agent-ok`, `needs-owner`, `needs-grooming`, `<!-- factory -->`). Comment kinds and their tags: `docs/factory.md` in giocaizzi/harness.

## Gather

```bash
gh issue list --state open --label needs-owner --json number,title,url,updatedAt
gh issue list --state open --label needs-grooming --json number,title,url
gh issue list --state open --label agent-ok --json number,title,url,labels
gh issue list --state closed --label agent-ok --search "closed:>=<YYYY-MM-DD>" --json number,title,url,closedAt
gh issue view <N> --json comments,closedByPullRequestsReferences
```

For each open ticket, the comments tell its state: a `factory:question Q<n>` with no unmarked approver comment after it is the open question; a `factory:plan` means work started; the newest `factory:result` gives the last end state.

## Report

Sections in this order, one line per ticket with its link; leave a section out when empty:

| Section | Ticket | Line |
|---|---|---|
| Needs you | `needs-owner` | `#N title · Q<n>: <the question, one line> · since <date>` |
| In progress | approval label and a plan, not parked | `#N title · PR #<pr> <checks green/red/pending>` or `no PR yet` |
| Grooming | `needs-grooming` | `#N title · parked three times` |
| Approved, not started | approval label, no plan comment | `#N title` |
| Done | closed in the window with a `done` result | `#N title · PR #<pr> merged` |

No narration and no advice: the owner reads the questions and answers them on the tickets.
