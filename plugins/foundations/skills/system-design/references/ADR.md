# Architecture decision records

## When to write one

| Write | Do not write |
|---|---|
| New datastore, queue, cloud service, language or framework | Local refactor, naming |
| Consistency, tenancy, auth or data-ownership choice | A choice reversible in one PR |
| Departing from a default in this skill | A decision an existing ADR already covers |
| Anything a future reader would question | |

## Where

One decision per file: `docs/adr/NNNN-slug.md` (zero-padded sequence), or the repo's own ADR folder and numbering when it has one. Never edit an accepted ADR: write a new one and mark the old `superseded by NNNN`.

## Template

```markdown
# NNNN. Title (the decision, imperative)

- Status: proposed | accepted | superseded by NNNN | deprecated
- Date: YYYY-MM-DD
- Deciders: names or roles

## Context
Forces and constraints, with the NFR numbers.

## Options
| Option | For | Against | Cost |
|---|---|---|---|

## Decision
What was chosen and the deciding reason.

## Consequences
Good, bad, and what must now be true (migrations, runbooks, alerts).

## Revisit when
A measurable trigger.
```

## Rules

- At least two real options, one of them "do nothing".
- State what would reverse the decision.
- Link the ADR from the PR that implements it.
