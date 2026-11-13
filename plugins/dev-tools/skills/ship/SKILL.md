---
name: ship
description: "Use when the user asks to commit, push, save or back up work, put it up for review, or open a PR; /ship [ready]. Small Conventional Commits, push every commit, draft PR on first push."
---

# Ship

Take the working tree to an open PR. Arguments: an optional hint for the commit message, or `ready`. The argument is the text after the skill name, repeated here when the harness fills it in: $ARGUMENTS

1. **Not on the default branch**, unless the repo's `AGENTS.md` allows direct commits to it: then commit and push there, no PR (`github-pull-requests`, Branch lifecycle). Otherwise start a branch (`wt`).
2. **Look before staging.** Read `git status` and the diff. Never stage secrets, `.env` files or build output; if a value looks like a credential, stop and say so (see `secrets-handling`).
3. **Commit in logical units**, each a Conventional Commit (see `conventional-commits`) explaining what and why, unless the repo has its own commit convention. Several small commits beat one large one, grouped per issue in a batched PR (`github-pull-requests`).
4. **Check before ready.** A push to a draft needs no check: it is a backup. Before marking the PR ready and before each push to a ready PR, run `make check`, or the repo's own check command, on the tree merged with the current default branch (`github-pull-requests`, Landing a change, rule 5); do not mark ready or push to a ready PR on a failing tree. Where CI runs the same full suite on every PR, build, type-check and run the targeted tests locally and leave the full suite to CI (`host-hygiene`, Don't verify twice); report the exit status of the check itself, never of a pipe after it. Before marking ready, run the pre-review self-check (`subagent-orchestration`, references/pre-review.md). Also run the repo's `prepush` target where it has one, then mark the PR ready once (`gh pr ready`; `github-actions`, CI for a gate: checklist, Drafts run no CI).
5. **Push every commit** with upstream tracking (`github-pull-requests`, Branch lifecycle). On a ready PR a round is one commit (rule 1), and never push to an armed or queued PR (rule 9). A throwaway CI probe goes in a draft PR (where drafts run no CI, start it with `gh workflow run <workflow> --ref <branch>`).
6. **Open a draft PR on the first push** if the branch has none (`gh pr create --draft`, `glab mr create --draft`, `az repos pr create --draft true`; detection and flags in `repo-standard`). Mark it ready once, after step 4 (`gh pr ready`), with the title and body still true to the work (`github-pull-requests`, Branch lifecycle). Arm merging with `land`, not here.
   - **Scope:** one PR carries the whole batch (`github-pull-requests`, Branch lifecycle); a split only with a listed `Split-Reason:` (rule 1). The guard's `pr-batch` rule enforces this (`github-pull-requests` rule 1).
   - **Base:** dependent work is stacked (a layer is opened with `gh stack submit` where stacked PRs are enabled, not `gh pr create`), independent work targets the default branch (`github-pull-requests`, Landing a change, rule 4). Build a stack with `git fetch origin main:main` (init bases the bottom layer on the local default ref), `gh stack init` and `gh stack add` per layer, then `gh stack submit --auto --open`; for PRs that are already open and chained, `gh stack link <bottom> <mid> <top>` registers them without a push or rewrite. Push a stack branch with `--force-with-lease` only, and only on your own feature or stack branches, never the default branch, a shared branch or another agent's branch (`github-pull-requests`, Stacked PRs).
   - **Title:** `type(scope): lowercase description`. With squash merge it becomes the commit on `main`, so pick the type for the whole PR.
   - **Body:** the repo's PR template if it has one, else `## What`, `## Why`, `## Verification` (commands run and their result, checks skipped and why).
   - **Footers last, one per line, no indentation:** `BREAKING CHANGE:`, the issue lines (`Closes #n` or `Refs: #n`, see `github-pull-requests`), then attribution. The squash commit body is the PR description, so a footer only in a branch commit is lost.
   - **Attribution:** one `Co-Authored-By:` trailer per model that actually wrote code in the PR, named exactly as the harness reports it (subagents on another model add theirs), then the harness's generated-by line. Same trailer on each commit. Never guess or copy a model name; human-only work gets none; bots attribute themselves.

Report the PR URL and what was committed.

## Gotchas

- `gh pr create --draft` with no commits ahead of the base fails (`No commits between`): push the first commit, then open the PR.
