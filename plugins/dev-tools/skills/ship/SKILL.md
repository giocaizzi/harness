---
name: ship
description: Commit the current changes as small Conventional Commits, push the branch and open a PR if none exists. Use when the user asks to commit, push or open a PR, or types /ship (optionally "draft").
---

# Ship

Take the working tree to an open PR. Arguments (`$ARGUMENTS`): an optional hint for the commit message, or `draft`.

1. **Not on the default branch.** If on `main`, stop and start a branch (see `wt`). Pushing to the default branch is never the intent.
2. **Look before staging.** Read `git status` and the diff. Never stage secrets, `.env` files or build output; if a value looks like a credential, stop and say so (see `secrets-handling`).
3. **Commit in logical units**, each a Conventional Commit (see `conventional-commits`) explaining what and why. Several small commits beat one large one.
4. **Check.** Run `make check` when the repo has it; do not push a failing tree.
5. **Push** with upstream tracking.
6. **Open the PR** if the branch has none: `gh pr create`, titled as a Conventional Commit, body = what changed and why; `--draft` when asked. Arm merging with `land`, not here.

Report the PR URL and what was committed.
