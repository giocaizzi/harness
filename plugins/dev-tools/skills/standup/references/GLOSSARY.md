# Glossary

Gloss a term in the report at its first mention, in these words or shorter. Add a term here when a report needs one that is missing.

| Term | Plain gloss |
|---|---|
| CI | Automatic tests and checks that run on every change before it can be accepted. |
| check | One of those automatic tests; it is green (passed), red (failed) or pending (still running). |
| PR | Pull request: a proposal to add a set of changes to the main code, which others can review. |
| merge | Accept a proposed change into the main code. |
| merge queue | A waiting line that merges accepted changes one at a time, re-testing each against the latest main code. |
| auto-merge | A switch that merges a change by itself as soon as its checks pass. |
| stack | Several changes built one on top of the other, merged in order. |
| base | The change or branch that another change builds on and is compared against. |
| rebase | Replay a change on top of newer code so it applies cleanly. |
| worktree | A separate working copy of the project on disk, so two tasks do not overwrite each other. |
| branch | A named line of work holding a change that is not yet in the main code. |
| SHA | The unique ID of one saved change (commit), a string like `a1b2c3d`. |
| release | A published, numbered version of the software. |
| deploy | Put a version live where people use it. |
| driver | An AI helper that plans and coordinates a larger piece of work. |
| worker | An AI helper that makes one fully specified change. |
| reviewer | An AI helper that checks a change and reports problems without editing it. |
| subagent | Any AI helper started by the main session to do part of the work. |
| peer session | Another AI session working on the same project at the same time. |
| cache | A stored copy of installed files that updates only when the version changes. |
| version bump | Raising the version number so installed copies know there is something new. |
