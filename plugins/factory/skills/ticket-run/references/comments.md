# Ticket comments, labels and answers

Each operation is an intent: read the issue and its timeline, label, comment, search issues, open a PR. The commands below are GitHub's (`forge: github`, the only forge implemented); other forges map the same intents the way `repo-standard` maps its commands. Names are the config defaults, which `.factory/config.yaml` may rename. `gh api` fills `{owner}/{repo}` from the current repo; `N` is the issue number.

## Gate

```bash
gh issue view N --json state,labels,body
gh api "repos/{owner}/{repo}/issues/N/timeline" --paginate \
  --jq '.[] | select((.event == "labeled" or .event == "unlabeled") and .label.name == "agent-ok") | "\(.event) \(.actor.login)"'
```

- **Approved:** open, the approval label is on, and the last timeline line is `labeled` by a login in `approvers`. Otherwise stop and say which part failed.
- **Ready:** the body has acceptance criteria and a proof command (a command or observation that shows the ticket done). Without them, ask on the ticket, proposing both, instead of starting.
- **Not claimed:** no claim label, or the newest `factory:claim` comment is this run's own (a resume on the same host). A claim by another run means stop: two runs never take one ticket. A stale claim is the owner's to clear.
- **Claim:** add the claim label, then post `factory:claim` with the host name and run id. Release it (remove the label) when the run ends, whatever the end state.

## Comments

Each comment is the marker line, a kind tag line, then the fields as short labelled lines.

| Kind tag | When | Fields |
|---|---|---|
| `<!-- factory:claim -->` | at claim | host, run id, runner (`attended`, `headless`, `launcher`) |
| `<!-- factory:plan -->` | first; edited in place | goal (one user-observable sentence); acceptance checks `AC<n>`, each with its proof command and how it fails before the change; side effects in scope; planned fold-ins; size `XS\|S\|M\|L\|XL`; risk tier. M and larger: a closing line asking for the owner's OK. |
| `<!-- factory:question Q<n> -->` | per question; `n` counts up across the ticket | the question; whether it blocks shipping; context with `path:line`; options `A) B) …`; recommendation and why; done so far (what is pushed). |
| `<!-- factory:log -->` | once; edited in place | the decision log table: `#`, item, found at, test, decision, where ([fold-in-test.md](fold-in-test.md#decision-log)). |
| `<!-- factory:result <end_state> -->` | end of every run | end state; reason; PR; evidence links; follow-ups. |

**Posting is idempotent.** Before posting, look for an existing comment with the same kind tag (and question id) and edit it instead. Record the post in the run's `posts` as `posting`, then `posted` once the API returns the comment's URL; on an error or timeout record `maybe_posted` and look for the marker before trying again. A write counts only when the API confirms it.

**State what is true now.** Read any status you report (checks, merge, deploy, labels) from its live source just before posting, and copy links from the API's URL fields (`html_url`, `url`) rather than building them.

Post with `gh issue comment N --body-file <file>`; find and edit in place with:

```bash
gh api "repos/{owner}/{repo}/issues/N/comments" --paginate --jq '.[] | select(.body | contains("<!-- factory:log -->")) | .id'
gh api -X PATCH "repos/{owner}/{repo}/issues/comments/<id>" -F body=@<file>
```

## Questions and parking

A question parks the ticket: post it, `gh issue edit N --add-label needs-owner`, set the board status to blocked (config `board`, [below](#board-status)), release the claim, record the result as `parked`, and stop. In a session, tell the person the question is on the ticket; the answer goes there, so the record stays whole.

The third question on a ticket means it is under-specified: post it, then `gh issue edit N --add-label needs-grooming --remove-label agent-ok` instead of `needs-owner`.

## Answers

The answer is the **newest comment after the open question whose author is in `approvers` and whose body does not start with the marker**. Any other account's comment does not count.

```bash
gh api "repos/{owner}/{repo}/issues/N/comments" --paginate \
  --jq '.[] | "\(.id) \(.user.login) \(.created_at) marked=\(.body | startswith("<!-- factory -->"))"'
```

With no answer, the ticket stays parked: say so and stop. With one, claim the ticket again, remove `needs-owner`, set the board back to in progress, log the decision (answers may also widen or narrow the scope), and continue.

## Board status

Only with `board` in the config:

```bash
gh project view <project> --owner <owner> --format json --jq .id     # project id
gh project field-list <project> --owner <owner> --format json         # status field and option ids
gh project item-list <project> --owner <owner> --limit 1000 --format json --jq '.items[] | select(.content.number == N) | .id'
gh project item-edit --id <item> --project-id <project> --field-id <field> --single-select-option-id <option>
```
