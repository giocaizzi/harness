# Ticket comments, labels and answers

Names below are the config defaults; `.factory/config.yaml` may rename them. `gh api` fills `{owner}/{repo}` from the current repo; `N` is the issue number.

## Gate

```bash
gh issue view N --json state,labels,body
gh api "repos/{owner}/{repo}/issues/N/timeline" --paginate \
  --jq '.[] | select((.event == "labeled" or .event == "unlabeled") and .label.name == "agent-ok") | "\(.event) \(.actor.login)"'
```

It passes when the issue is open, has the label, and the last timeline line is `labeled` by a login in `approvers`. Otherwise stop and say which part failed. A body without acceptance criteria is not a failure: the plan proposes them.

## Comments

Each comment is: the marker line, a kind tag line, then the fields as short labelled lines. Post with `gh issue comment N --body-file <file>`; edit in place with `gh api -X PATCH "repos/{owner}/{repo}/issues/comments/<id>" -F body=@<file>`.

| Kind tag | When | Fields |
|---|---|---|
| `<!-- factory:plan -->` | first; edited in place | goal (one user-observable sentence); acceptance checks `AC<n>`, each with its check and how it fails before the change; side effects in scope; planned fold-ins; size `XS\|S\|M\|L\|XL`; risk tier. M and larger: a closing line asking for the owner's OK. |
| `<!-- factory:question Q<n> -->` | per question; `n` counts up across the ticket | the question; whether it blocks shipping; context with `path:line`; options `A) B) …`; recommendation and why; done so far (what is pushed). |
| `<!-- factory:log -->` | once; edited in place | the decision log table: `#`, item, found at, test, decision, where (vocabulary in [fold-in-test.md](fold-in-test.md#decision-log)). |
| `<!-- factory:result <end_state> -->` | end of every run | end state `done\|parked\|failed`; reason; PR; evidence links; follow-ups. |

## Questions and parking

A question parks the ticket: post it, `gh issue edit N --add-label needs-owner`, set the board status to blocked (config `board`, [below](#board-status)), record the result as `parked`, and stop. In a session, tell the person the question is on the ticket; the answer goes there, so the record stays whole.

The third question on a ticket means it is under-specified: post it, then `gh issue edit N --add-label needs-grooming --remove-label agent-ok` instead of `needs-owner`.

## Answers

The answer is the **newest comment after the open question whose author is in `approvers` and whose body does not start with the marker**. Any other account's comment does not count.

```bash
gh api "repos/{owner}/{repo}/issues/N/comments" --paginate \
  --jq '.[] | "\(.id) \(.user.login) \(.created_at) marked=\(.body | startswith("<!-- factory -->"))"'
```

With no answer, the ticket stays parked: say so and stop. With one, remove `needs-owner`, set the board back to in progress, log the decision (answers may also widen or narrow the scope), and continue.

## Board status

Only with `board` in the config:

```bash
gh project view <project> --owner <owner> --format json --jq .id     # project id
gh project field-list <project> --owner <owner> --format json         # status field and option ids
gh project item-list <project> --owner <owner> --limit 1000 --format json --jq '.items[] | select(.content.number == N) | .id'
gh project item-edit --id <item> --project-id <project> --field-id <field> --single-select-option-id <option>
```
