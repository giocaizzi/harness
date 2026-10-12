---
name: github-workflow
description: Landing changes on main via pull requests: stacked PRs with `gh stack`, auto-merge, merge queues, and rulesets that require CI. Use when opening, splitting or merging PRs, or setting up branch protection or merge-gating CI.
---

## Principle

`main` only changes through a pull request that passed CI. Humans and agents never push to it, never bypass the rules, and never merge by hand when the platform can merge once checks pass.

## Landing a change

1. **Small PRs, stacked when layered.** One logical change per PR. If work has more than one reviewable layer (schema → API → UI), stack them instead of one large PR.
2. **Auto-merge, not manual merge.** Open the PR, then `gh pr merge <n> --auto --squash --delete-branch`. It merges when required checks pass. Do not poll and merge by hand.
3. **Merge queue when the repo has one.** With a queue, the same command enqueues the PR; do not pass a merge method the queue overrides.
4. **Never bypass.** No admin override, no `--admin`, no disabling a rule to get a PR through. A failing required check is fixed, or the check is corrected in its own PR.

## Stacked PRs

Native stacks are a GitHub feature (public preview 2026-07-30, rolling to GA) driven by the `gh stack` extension. Verify against the [docs](https://docs.github.com/en/pull-requests/reference/stacked-prs-cli-commands) — the feature is new.

```bash
gh extension install github/gh-stack     # needs gh >= 2, git >= 2.36
gh stack init -b main                    # start a stack
gh stack add -A -m "feat: schema"        # new branch on top (run from the top branch)
gh stack submit                          # push + create/update PRs as a stack
gh stack sync                            # fetch, rebase, push; after a lower PR merges
gh stack merge                           # merge up to a chosen PR, all-or-nothing
```

- The repository must have stacked PRs enabled; otherwise commands fail (exit 9).
- Merging a PR lands every unmerged layer beneath it. Branch protection and rulesets still apply and cannot be bypassed.
- On a repo with a merge queue, `gh stack merge` enqueues the stack and ignores the merge-method flags.
- Rewrite a stack with `gh stack modify` / `rebase`, never by hand-rebasing individual branches.
- Stacks need a linear history; avoid merge commits inside a stack.

## Rulesets on the default branch

Prefer a **repository ruleset** over classic branch protection: it layers, can be evaluated before enforcing, and is the only place the merge-queue rule exists. Minimum for `main`:

| Rule | Setting |
|---|---|
| Require a pull request | on; approvals `0` for solo repos, `1+` with collaborators |
| Require status checks | the CI job names; up-to-date branch required unless a merge queue does that |
| Block force pushes and deletion | on |
| Require merge queue | on when the repo supports it (see below) |
| Bypass list | empty |

Enable auto-merge once per repo: `gh repo edit --enable-auto-merge`.

Apply with the API, and **confirm per repo first** — a required-checks rule on a repo with no CI blocks every merge:

```bash
gh api repos/OWNER/REPO/rulesets --method POST --input ruleset.json
gh api repos/OWNER/REPO/rulesets --jq '.[] | {id,name,enforcement}'   # audit
```

Start with `"enforcement": "evaluate"` where available, then switch to `"active"`. Check field names against the [rulesets docs](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets); they change.

## CI that gates merges

- Required checks must be **stable job names**: renaming a job silently unblocks the rule or blocks all PRs.
- With a merge queue, run the same checks on `merge_group` as well as `pull_request`. Without that trigger, queued merges never get their checks and fail.
  ```yaml
  on:
    pull_request:
    merge_group:
  ```
- Prefer one final aggregate job (`needs: [...]`, `if: always()`) as the single required check, so matrix changes don't touch the ruleset.
- A path-filtered workflow that is skipped leaves its required check pending; use the aggregate job or avoid path filters on required workflows.

## Merge queue availability

Merge queue is a repository-level ruleset rule and is not offered on every repository: it depends on ownership and plan (for example organization-owned repos; private repos need a qualifying plan). On a repo that cannot have one, fall back to auto-merge + required checks + "require branches to be up to date". Check availability before promising a queue.

## Standardizing many repos

Keep one canonical standard in a single repo (`<owner>/.github`): a prose standard in `docs/`, machine-readable parts (ruleset JSON, labels, repo settings) in `standard/`, and a read-only audit script that reports drift per repo. Change the standard there first, then the repos.

Apply in this order, lowest risk first: repo settings, labels, CI with one aggregate `check` job, and only then the ruleset that requires it. A ruleset applied to a repo without that check blocks every merge. Re-run the audit after each repo; it must report no drift.

## Before handoff

- PR is small, titled as a Conventional Commit (see `conventional-commits`), and auto-merge is armed.
- Required checks are green or running; nothing was bypassed.
- Stacked work was submitted as a stack, not as independent PRs targeting each other by hand.
