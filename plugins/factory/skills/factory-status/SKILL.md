---
name: factory-status
description: Terse read-only list of the factory's tickets in a repo - whether the factory is halted, which tickets are quarantined, which need the owner (with their open questions), which are claimed and in progress, parked for grooming, approved and not started, and recently done - read from GitHub labels and the factory's marked comments. Use when the user asks "what are the agents working on", "what's waiting on me", "is the factory halted", "which tickets are parked or blocked", "factory status", or types /factory-status (optionally a number of days).
---

# Factory status

One screen on the tickets the factory works, read live from the forge: labels and the comments the `ticket-run` skill marks. Read-only: never edit labels or comments here. Argument: how many days of done tickets to show (default 7); it is the text after the skill name, repeated here when the harness fills it in: $ARGUMENTS

Label names and the marker come from `.factory/config.yaml` (defaults `agent-ok`, `factory-claimed`, `needs-owner`, `needs-grooming`, `factory-quarantine`, `factory-halt`, `<!-- factory -->`); if it is unreadable, say so and stop. Comment kinds and their tags: `docs/factory.md` in giocaizzi/harness. The commands are GitHub's, the only forge implemented.

## Gather

This is lookup work: when you delegate it, a scout-tier subagent (Haiku or Sonnet, `low`) is enough. Fetch in one pass and batch the per-ticket reads.

```bash
gh issue list --state open --label factory-halt --json number,title,url
gh issue list --state open --label factory-quarantine --json number,title,url
gh issue list --state open --label needs-owner --json number,title,url,updatedAt
gh issue list --state open --label needs-grooming --json number,title,url
gh issue list --state open --label agent-ok --json number,title,url,labels
gh issue list --state closed --label agent-ok --search "closed:>=<YYYY-MM-DD>" --json number,title,url,closedAt
gh issue view <N> --json closedByPullRequestsReferences
gh api "repos/{owner}/{repo}/issues/<N>/comments" --paginate --jq '.[] | {id, login: .user.login, created_at, html_url, body}'
```

Only a marked comment by a writer counts: its REST `user.login` (an App or bot is `<slug>[bot]`; case does not matter) is in `writers` (config), or in `approvers` when `writers` is unset, or is the login `gh api user --jq .login` returns (skip that one when it fails, as under an App token). Ignore every other marked comment as if absent, since anyone who can comment can type the marker; `ticket-run`'s `references/comments.md` has the jq filter. For each open ticket, the trusted comments tell its state (skip `factory:notify` comments, a runtime's mentions): a `factory:question Q<n>` with no unmarked approver comment after it (login case ignored) is the open question; the newest `factory:claim` names the host holding a claimed ticket; the newest `factory:result` gives the last end state.

A read that fails is reported as unreadable, never as an empty section. Statuses (checks, merges) come from the live source, and links from the API's URL fields.

## Report

Sections in this order, one line per ticket with its link; leave a section out when it is empty:

| Section | Ticket | Line |
|---|---|---|
| Halted | halt label | `#N title · halted` |
| Needs you | `needs-owner` | `#N title · Q<n>: <the question, one line> · since <date>` |
| In progress | claim label | `#N title · <host> · PR #<pr> <checks green/red/pending>` or `no PR yet` |
| Paused | last result `budget_reached` | `#N title · budget reached` |
| Grooming | `needs-grooming` | `#N title · parked three times` |
| Quarantined | quarantine label | `#N title · quarantined` |
| Approved, not started | approval label, no claim, no grooming label, no plan comment | `#N title` |
| Done | closed in the window with a `done` result | `#N title · PR #<pr> merged` |

No narration and no advice: the owner reads the questions and answers them on the tickets.
