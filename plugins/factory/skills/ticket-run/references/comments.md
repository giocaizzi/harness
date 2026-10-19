# Ticket comments, labels and answers

`<marker>`, label names and approvers come from `.factory/config.yaml` (defaults: `<!-- factory -->`, `agent-ok`, `needs-owner`, `needs-grooming`). `gh api` fills `{owner}/{repo}` from the current repo. `N` is the issue number.

## Gate

```bash
gh issue view N --json state,labels,title,body
gh api "repos/{owner}/{repo}/issues/N/timeline" --paginate \
  --jq '.[] | select((.event == "labeled" or .event == "unlabeled") and .label.name == "agent-ok") | "\(.event) \(.actor.login) \(.created_at)"'
```

Pass only when the state is open, the label is on the issue, and the last line of the timeline output is `labeled` by a login in `approvers`. A body with no acceptance criteria is not a gate failure: write them in the plan, and M or larger tickets get them confirmed with the plan.

## Comment shapes

Every comment starts with the marker line, then a kind tag, then the visible text. Write the body to a file and post it with `gh issue comment N --body-file <file>`.

**Plan** (once; edit it in place when the plan changes):

```markdown
<marker>
<!-- factory:plan -->
**Plan** · size S · risk low
Goal: <one user-observable sentence>
Acceptance:
- AC1 <behaviour>. Check: `<command or observation>`. Fails before the change: <how>.
Side effects in scope: <tests, docs, migration, config, deploy, live verify: the ones that apply>
Planned fold-ins: <items, or none>
```

For M and larger, end the plan with `Reply OK to start, or say what to change.` and park as for a question.

**Question** (one per comment, numbered across the ticket):

```markdown
<marker>
<!-- factory:question Q2 -->
**Q2 (blocks ship):** <one question>
Context: <what was found, path:line, why it matters>
Options: A) <...> B) <...>
Recommended: A, because <...>
Done so far: <what is committed and pushed on the branch>
```

**Decision log** (once; edit in place, and copy the table into the PR body as `## Scope`):

```markdown
<marker>
<!-- factory:log -->
**Decision log**
| # | Item | Found at | Test | Decision | Where |
|---|---|---|---|---|---|
```

**Result** (at the end of every run): `<!-- factory:result <done|parked|failed> -->` after the marker, then the end state, the PR, evidence links and follow-ups: the facts of `result.json`.

Edit a comment in place with its id:

```bash
gh api "repos/{owner}/{repo}/issues/N/comments" --paginate --jq '.[] | select(.body | contains("<!-- factory:log -->")) | .id'
gh api -X PATCH "repos/{owner}/{repo}/issues/comments/<id>" -F body=@<file>
```

## Answers

The answer to the open question is the **newest comment after it whose author is in `approvers` and whose body does not start with the marker**. Comments by any other account do not count, whatever they say.

```bash
gh api "repos/{owner}/{repo}/issues/N/comments" --paginate \
  --jq '.[] | "\(.id) \(.user.login) \(.created_at) marked=\(.body | startswith("<!-- factory -->"))"'
```

On an answer: remove the needs-owner label, set the board status back to in progress, add a log row for the decision, and continue. An answer can also widen or narrow the scope; log that too.

## Parking

After posting a question (or the M+ plan):

```bash
gh issue edit N --add-label needs-owner
```

and, with a `board` in the config, set its status field to the blocked option. Then write the result as `parked` and stop. In an attended session, tell the person the question is on the ticket; the answer still goes there, so the record stays whole.

**Third park.** Count the `factory:question` comments on the ticket. When a third question would be needed, post it, then `gh issue edit N --add-label needs-grooming --remove-label agent-ok` instead of `needs-owner`: the ticket is under-specified and goes back to the owner.

## Board status

Only when the config has `board`. Find the ids once per run, then edit the item:

```bash
gh project view <project> --owner <owner> --format json --jq .id                 # project id
gh project field-list <project> --owner <owner> --format json                     # status field id and option ids
gh project item-list <project> --owner <owner> --limit 1000 --format json \
  --jq '.items[] | select(.content.number == N) | .id'                            # the issue's item on the board
gh project item-edit --id <item-id> --project-id <project-id> --field-id <field-id> --single-select-option-id <option-id>
```
