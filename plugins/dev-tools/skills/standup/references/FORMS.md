# Forms

Default forms are text that renders in a terminal. Mermaid only when the user asks.

| Content shape | Form |
|---|---|
| A choice with branches, each leading somewhere different | Decision tree |
| Three or more items sharing the same attributes | Table |
| Flow, order or what builds on what (a stack of changes, a pipeline) | ASCII diagram |
| One or two items | A sentence; no form |

Refs (`#n`, SHAs) never start a line or a row; they close it, and only under `detail`. Skeletons below show the interface (columns, nodes), not a recap.

## Decision tree

```
<question>?
├─ yes -> <what happens>  (recommended)
└─ no  -> <what happens>
```

## Table

| <item> | <state> | <blocked on or next> |
|---|---|---|

Done / In flight uses: change in plain words, state (merged, checks passing, checks running, waiting), what it waits on. Cap Done at 5 rows, then "and N more".

## ASCII diagram

```
main
 └─ <change 1>  (<state>)
     └─ <change 2>  (<state>)
         └─ <change 3>  (<state>)
```

Read order: top is merged first. Add one line under it saying what blocks the next step.
