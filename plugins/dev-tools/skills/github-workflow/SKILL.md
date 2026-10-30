---
name: github-workflow
description: "Landing changes on main via pull requests: stacked PRs with `gh stack`, auto-merge, merge queues, and rulesets that require CI. Use when opening, splitting or merging PRs, or setting up branch protection or merge-gating CI."
---

## Principle

`main` only changes through a pull request that passed CI. Humans and agents never push to it, never bypass the rules, and never merge by hand when the platform can merge once checks pass.

This skill is the GitHub mechanics. The repo checklist (aggregate `check`, title check, squash, protection) and the GitLab / Azure DevOps equivalents are in `repo-standard`.

## Landing a change

1. **One PR per batch, by default.** Related issues or tasks in your scope that can land cleanly in one review go in one PR, with no size cap: every extra PR costs a CI run, a serial merge or queue slot, and another re-merge and review round on a moving base, so speed beats small diffs. The body carries one `Closes #n` or `Refs: #n` line per issue; the commits are grouped per issue, and tests and docs ship in the same PR; with release-please, list each change in the body (`release-please`). Split only when parts can land independently in parallel, touch unrelated areas with different reviewers or risk tiers, or conflict. Work with more than one reviewable layer (schema → API → UI) is a stack (rule 4). A workflow skill that scopes a PR to one approved ticket keeps its own rule.
2. **Auto-merge, not manual merge.** Open the PR, then `gh pr merge <n> --auto --squash --delete-branch`. It merges when required checks pass. Do not poll and merge by hand, except where auto-merge is unavailable (private repos on the Free plan): then `land` merges directly once every check passed, never with `--admin`.
3. **Merge queue when the repo has one.** With a queue, the same command enqueues the PR; do not pass a merge method the queue overrides. See Merge queue speed.
4. **Dependent work is a stack, independent work is not.** A chain of 2 or more dependent PRs is built with `gh stack` (`init`, `add`, `submit`, `sync`) where the repo has stacked PRs enabled (Stacked PRs; `gh stack` exits 9 otherwise): one small buildable PR per layer, the bottom layer on the default branch, merged bottom-up (`gh stack merge`, or `land`); the stack gives the chain view and retargets each layer as the one below merges. Never hand-build a pile of PRs retargeted by hand; only where `gh stack` is unavailable or not enabled, follow Stacks without `gh stack`. Siblings (several PRs that each need one base PR but not each other) follow Stacks without `gh stack`. A PR that does not need another one targets the default branch directly, so it lands in parallel.
5. **Check the tree it will merge into.** The queue, or a required up-to-date branch, re-runs the required checks on the PR merged with the current default branch, not on the branch as approved. Before pushing, and again before enqueueing a PR whose base moved, merge `origin/<default>` into a scratch copy (or the branch) and run the full check there.
6. **Never bypass.** No admin override, no `--admin`, no disabling a rule to get a PR through. A failing required check is fixed, or the check is corrected in its own PR.

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
- A PR in a stack (its REST resource carries a `stack` object) cannot be merged or enqueued through the legacy merge endpoints and mutations: `gh pr merge` refuses it (`This pull request is part of a stack and must be enqueued using the asynchronous merge REST API`). Enqueuing or merging it needs the [asynchronous merge API](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2026-03-10#merge-a-pull-request-asynchronously), which `gh stack merge <n>` uses and which lands every PR of the stack up to and including `<n>` atomically (all merge or join the queue, or none do). Without the extension: `gh api -X PUT repos/{owner}/{repo}/pulls/<n>/merge-async -H 'X-GitHub-Api-Version: 2026-03-10' -f merge_action=merge_queue -f sha=<head>` (no queue: `-f merge_action=default -f merge_method=squash`) answers with a `uuid`; poll `gh api repos/{owner}/{repo}/pulls/<n>/merge-async/<uuid>` until `status` is `merged`, `enqueued` (final for a queue request: the PR is queued, not merged) or `failed` (rulesets and protection run only then, so a failure shows here). `land-many` does this on its own.
- Rewrite a stack with `gh stack modify` / `rebase`, never by hand-rebasing individual branches.
- Stacks need a linear history; avoid merge commits inside a stack.

### Stacks without `gh stack`

A child PR based on another PR's branch, merged one PR at a time with squash (the squash drops the merge commits below from `main`):

1. **Retarget before the parent merges.** List the children (`gh pr list --base <parent-branch>`) and move each to the default branch (`gh pr edit <child> --base <default>`) before arming the parent's merge. Deleting the parent's branch on merge can close every child based on it; GitHub retargets children itself only in some cases, so don't rely on it. A retargeted child now shows the parent's commits too: keep its auto-merge off until the parent has merged.
2. **Update each child after the squash.** The child still carries the parent's pre-squash commits. Merge the default branch into it (`git merge origin/<default>`; no rebase, no force push), resolve conflicts keeping the child's side, push, let checks re-run, then land it.
3. **A child already closed this way:** recreate the base at the parent's last head on the server (`gh pr view <parent> --json headRefOid`, then `gh api repos/{owner}/{repo}/git/refs -f ref=refs/heads/<parent-branch> -f sha=<sha>`), reopen the child (`gh pr reopen <child>`), retarget it as in step 1, then delete the recreated branch.

- **Siblings** (several PRs that each need one base PR but not each other) are all children of that PR: retarget every one by hand before the parent merges, as in step 1 (`gh pr list --base <parent-branch>` lists them all), then update each as in step 2. Siblings that change the same files are serialised as one chain instead, each based on the one before, so no two of them conflict after the squash.

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

- With a merge queue, run the same checks on `merge_group` as well as `pull_request`. Without that trigger, queued merges never get their checks and fail.
  ```yaml
  on:
    pull_request:
    merge_group:
  ```
- A path-filtered workflow that is skipped leaves its required check pending; use the aggregate `check` job (see `repo-standard`) or avoid path filters on required workflows.

## Squash merges and PR titles

With squash-only repos, the PR title is the commit on `main` and drives release automation. Require a `Validate PR title` check next to `check` and pin the squash commit to the PR title and body; the settings and gotchas are in `conventional-commits`.

## Merge queue speed

A queue builds several entries at once and merges them in groups, so the speed comes from enqueueing every ready PR together: a loop that enqueues one PR and waits for it to merge before the next pays a full queue CI run per PR. Land a batch with `land`'s `land-many` script.

Read the queue's settings from the branch rules before planning around them: `gh api repos/OWNER/REPO/rules/branches/main --jq '.[] | select(.type == "merge_queue") | .parameters'`. `max_entries_to_build` is how many entries run CI at once, `min_entries_to_merge` / `max_entries_to_merge` the group size, `min_entries_to_merge_wait_minutes` how long the queue waits to fill a group, `grouping_strategy` (`ALLGREEN` or `HEADGREEN`) whether every entry of a group must pass, and `check_response_timeout_minutes` when a silent check fails the entry. An entry whose merge-group run fails is removed and the entries behind it are rebuilt.

With a queue, leave "require branches to be up to date before merging" off: the queue tests each entry on the latest base, so the rule only forces a merge-up and a re-review after every merge, and it serialises entries the queue would build in parallel. The consequence: a PR that conflicts with the base still needs the base merged in, and a semantic break between two PRs shows up in the queue run, not on the PR.

## Merge queue availability

Merge queue is a repository-level ruleset rule and is not offered on every repository: it depends on ownership and plan (for example organization-owned repos; private repos need a qualifying plan). On a repo that cannot have one, fall back to auto-merge + required checks + "require branches to be up to date". Check availability before promising a queue.

## Standardizing many repos

Keep one canonical standard in a single repo (`<owner>/.github`): a prose standard in `docs/`, machine-readable parts (ruleset JSON, labels, repo settings) in `standard/`, and a read-only audit script that reports drift per repo. Change the standard there first, then the repos. A repo's extra labels live in the repo itself (`.github/labels.yaml`), not in the standard repo, so a public standard never names a private repo; the label guard, the sync and the audit all read the standard plus that file.

New repos start from a template repository that already carries the standard files (CI with the aggregate `check`, PR-title, label-guard and TODO-issue workflows, Dependabot, Makefile, `AGENTS.md`), then one onboarding command applies settings, labels and workflows and adds the ruleset once `check` is green. On a personal account nothing applies the standard automatically, so the audit must run on a schedule with a read-only token and fail on an empty scope.

Roll out in the order `repo-standard` gives, labels with the settings, and re-run the audit after each repo; it must report no drift.

## Before handoff

- PR carries the whole batch the task named (Landing a change), is titled as a Conventional Commit (see `conventional-commits`), and auto-merge is armed.
- Required checks are green or running; nothing was bypassed.
- Stacked work was submitted as a stack, not as independent PRs targeting each other by hand; independent PRs target the default branch.
- The full check passed on the branch merged with the current default branch.
