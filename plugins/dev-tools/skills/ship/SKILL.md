---
name: ship
description: Commit the current changes as small Conventional Commits, push the branch and open a PR if none exists. Use when the user asks to commit, push or open a PR, or types /ship (optionally "draft").
---

# Ship

Take the working tree to an open PR. Arguments: an optional hint for the commit message, or `draft`. The argument is the text after the skill name, repeated here when the harness fills it in: $ARGUMENTS

1. **Not on the default branch.** If on `main`, stop and start a branch (see `wt`). Pushing to the default branch is never the intent.
2. **Look before staging.** Read `git status` and the diff. Never stage secrets, `.env` files or build output; if a value looks like a credential, stop and say so (see `secrets-handling`).
3. **Commit in logical units**, each a Conventional Commit (see `conventional-commits`) explaining what and why, unless the repo has its own commit convention. Several small commits beat one large one, grouped per issue in a batched PR (`github-workflow`).
4. **Check.** Run `make check`, or the repo's own check command, on the tree merged with the current default branch (`github-workflow`, Landing a change, rule 5); do not push a failing tree. Where CI runs the same full suite on every PR, build, type-check and run the targeted tests locally and leave the full suite to CI (`host-hygiene`, Don't verify twice); report the exit status of the check itself, never of a pipe after it.
5. **Push** with upstream tracking. Every pushed branch gets a PR: a throwaway CI probe goes in a draft PR, or its branch is deleted when the probe is done.
6. **Open the PR** (GitLab: MR) if the branch has none, with the forge's CLI (`gh pr create`, `glab mr create`, `az repos pr create`; detection and flags in `repo-standard`), as a draft when asked. Arm merging with `land`, not here.
   - **Base:** dependent work is stacked, independent work targets the default branch (`github-workflow`, Landing a change, rule 4).
   - **Title:** `type(scope): lowercase description`. With squash merge it becomes the commit on `main`, so pick the type for the whole PR.
   - **Body:** the repo's PR template if it has one, else `## What`, `## Why`, `## Verification` (commands run and their result, checks skipped and why).
   - **Footers last, one per line, no indentation:** `BREAKING CHANGE:`, the issue lines (`Closes #n` or `Refs: #n`, see `github-workflow`), then attribution. The squash commit body is the PR description, so a footer only in a branch commit is lost.
   - **Attribution:** one `Co-Authored-By:` trailer per model that actually wrote code in the PR, named exactly as the harness reports it (subagents on another model add theirs), then the harness's generated-by line. Same trailer on each commit. Never guess or copy a model name; human-only work gets none; bots attribute themselves.

Report the PR URL and what was committed.
