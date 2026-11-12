---
name: github-actions
description: "GitHub Actions mechanics and house settings: workflow triggers (pull_request, merge_group, push, schedule, workflow_dispatch), the concurrency block, the aggregate check job, draft PRs that run no CI, light and full tiers, job-level path filters, actions/cache save and restore, matrices and sharding, timeouts, permissions and OIDC, pull_request_target, flakes, and measuring Actions minutes with gh. Use whenever you write, review or debug a file under .github/workflows/ or an action.yml, run actionlint, gh run or gh workflow, or GitHub CI is slow, costly, flaky or a required check is stuck."
---

# GitHub Actions

The techniques and why are in `ci-cd`; this skill is how they are spelled on GitHub and the settings this house uses. Merge gating (rulesets, merge queue settings, landing PRs) is `github-workflow`.

## CI that gates merges

- With a merge queue, run the same checks on `merge_group` as well as `pull_request`. Without that trigger, queued merges never get their checks and fail.
  ```yaml
  on:
    pull_request:
    merge_group:
  ```
- A path-filtered workflow that is skipped leaves its required check pending: filter only as in the checklist below.

## CI for a gate: checklist

Techniques only; success is relative to the repo's own baseline, and security is never traded for speed.

- **Concurrency per PR.** A new push cancels the superseded PR run; never cancel `merge_group` or default-branch runs (a cancelled queue run drops the entry; a cancelled main run hides a break). Only PR runs share a group: GitHub cancels a pending run when a newer one joins its group even with `cancel-in-progress: false`, so every other run gets a group of its own (`github.run_id`).
  ```yaml
  concurrency:
    group: ${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.event.pull_request.number || github.run_id }}
    cancel-in-progress: ${{ github.event_name == 'pull_request' }}
  ```
- **Deploys** take a group keyed on the environment (`concurrency: { group: deploy-${{ inputs.environment }}, cancel-in-progress: false }`) and run in a GitHub environment with its own secrets and protection rules. Same caveat: a third queued deploy cancels the pending second.
- **One full run per tree.** With a merge queue that every change to the default branch must pass (the ruleset requires it and its bypass list is empty), the `merge_group` run is the full gate, and the push to the default branch lands the tree that run already tested: drop the full suite from the push (skip its suite jobs on `push` at the job level, with the aggregate `check` accepting their `skipped` only on `push`; take `push` out of a workflow's triggers only when it holds none of the jobs kept below), and keep there only what needs the landed commit: the secret scan, release and deploy jobs and every job or check they depend on (the aggregate `check` too, where a release or deploy waits on it), and the TODO tracking. This needs a nightly full run on the default branch (Flakes), which also saves the caches (Caches): add it first where the repo has none. Without a merge queue, the push run is the gate for the tree that landed (two PRs green apart can break together): keep the full suite on it, unless the ruleset requires branches to be up to date, where the PR run already tested the tree that lands and the owner may move that run to the nightly schedule. Before dropping a job from the push, check what consumes it (a `workflow_run` trigger, a deploy or release reading its status).
- **Two tiers, one gate.** Where that queue exists, PR runs carry the light tier (secret scan, `changes`, lint, the touched packages' tests), and the slower suites (integration, end-to-end, release dry-run, coverage floor) run only on `merge_group` and an opt-in `workflow_dispatch`, gated at the job level: `if: github.event_name == 'merge_group' || github.event_name == 'workflow_dispatch' || (github.event_name == 'pull_request' && !github.event.pull_request.draft && vars.CI_FULL_TIER_ON_PR == 'true')`. The repository variable is the rollback that puts the full tier back on PR runs without a workflow change. The aggregate `check` accepts `skipped` only for those jobs on `pull_request` and `push` (an explicit per-job, per-event allowlist) and, for a job a `changes` job gates, a skip only when `changes` said it was not needed (Path filters, below); it fails closed on any other skip.
- **Drafts run no CI.** The PR workflow lists `pull_request` `types: [opened, synchronize, reopened, ready_for_review]` (setting `types` replaces the defaults, which leave out `ready_for_review`) and also triggers on `workflow_dispatch`; its root jobs add `!github.event.pull_request.draft` to their `if` (true on every other event), and `check` runs on `always() && !github.event.pull_request.draft` with a `name` expression that names it differently on a draft (`${{ github.event.pull_request.draft && 'Skip CI (draft)' || 'check' }}`), so a skipped draft run never reports the required name. Prove the gate locally with the task runner's `prepush` target, then mark the PR ready once (`gh pr ready`); every later round is a push to the ready PR, never back to draft and ready again. A draft that needs CI runs it on demand: `gh workflow run <workflow> --ref <branch>`.
- **Timeouts.** `timeout-minutes` on every job, set from the job's own measured duration with headroom, so a hang fails instead of holding the gate; the queue's `check_response_timeout_minutes` at about 2-3x the merge-group run's p90.
- **Path filters only through a `changes` job**, heavy jobs first (a multi-arch image build, an emulator or device suite, a full e2e matrix): a path-filter step whose outputs gate the other jobs with `if: needs.changes.outputs.<x> == 'true'`, and the aggregate `check` (`repo-standard`) accepts `skipped` for a job only when `changes` said it was not needed, and fails on any other skip, failure or cancellation. The `changes` job filters only `pull_request` runs: on `merge_group` and default-branch pushes it outputs `true` for every filter, and it fails (never outputs `false`) when it cannot compute the diff, so no required job is skipped in the queue or on the default branch. Never a workflow-level path filter (`on.<event>.paths` or `paths-ignore`) on a required workflow: skip at the job level only, so the single aggregate `check` always reports. The secret scan, workflow lint (actionlint), dependency review and PR title check always run, with no filter.
- **Caches** keyed by the lockfile hash (`hashFiles('**/uv.lock')` etc.), saved only on a default-branch push or schedule (`actions/cache/save` under `if: github.ref == format('refs/heads/{0}', github.event.repository.default_branch)`) and restored everywhere (`actions/cache/restore`). Never a secret or token in a cached path; never restore a cache in `pull_request_target` (it runs with the base repo's secrets on untrusted code: a poisoned cache becomes code execution).
- **Shard a long suite** with a matrix (`shard: [1, 2, 3, 4]`) plus a script, run in CI, that fails unless the shards together list exactly the whole suite (no test dropped or run twice).
- **Trim a matrix** (fewer OS or versions) only on `pull_request` runs, and only where a merge queue runs the full matrix on `merge_group`, so the merged tree always gets the full matrix.
- **Larger or faster runners** are an owner setting (billing): proposed, never switched on by an agent.
- **Dependency updates in weekly batches**: grouped, on a weekly schedule, with a cap on open update PRs (`repo-standard`, Dependency update bot): each update PR pays the same PR, queue and push runs as any other.
- **Diagnose by symptom, measure both sides.** Measuring Actions minutes per workflow, event and runner: [references/ci-cost.md](references/ci-cost.md); where to cut given what it shows: `ci-cd`'s `references/diagnose.md`. Measure with the repo's CI health target over equal windows before and after every CI change, and keep the change only if the numbers improved.
- **Flakes.** A nightly `schedule` run of the full suite, and a task-runner target (for example `make ci-health`, the repo's own) that finds runs which failed and then passed on the same SHA: `gh run list --workflow <file> --json databaseId,headSha,attempt,conclusion` lists only each run's latest attempt, so read every earlier attempt of a run with `attempt` above 1 (`gh run view <id> --attempt <n> --json jobs`) and a failed job's log (`gh run view <id> --attempt <n> --log-failed`, or the suite's test report artifact) for the failing test's name; two runs of the same workflow on the same SHA with different conclusions count too. A flaky test gets an issue labelled `flaky` with a priority label; it is fixed or quarantined by the owner, never dropped from a required check without the owner.

## Security

- `permissions: {}` (or `contents: read`) at the workflow level, and each job grants only what it needs; `id-token: write` only on the job that exchanges the OIDC token.
- Third-party actions pinned by full commit SHA with a version comment (`repo-standard`); the update bot moves the pins.
- `pull_request_target` and `workflow_run` run with the base repo's secrets: never check out or run the PR's code in them.
- Untrusted text (`github.event.pull_request.title`, branch names, issue bodies) reaches a `run:` step through an `env:` variable, never as `${{ }}` inside the script.

## Gotchas

- A trigger-level `paths` (or `paths-ignore`) filter on a workflow that provides a required check leaves the check pending forever when no path matches; filter at the job level behind the aggregate `check`.
- A job skipped by its `if` reports success to a required status check: only the aggregate `check` decides whether a skip is allowed.
- Pushes, tags and PRs made with `GITHUB_TOKEN` start no workflow runs (except `workflow_dispatch` and `repository_dispatch`): a release or bot commit that must run CI uses a GitHub App token.
- A CI change that re-triggers itself (a workflow that commits or edits triggers it listens to) loops and makes CI slower; test it on a branch and read the first runs.
- A PR run restores caches from its own branch and the base branch only; a cache saved on a PR branch is reachable by that PR alone and evicts default-branch entries under the repository's cache size limit.
- Required checks name jobs: a matrix leg's name changes with its values, so require the aggregate `check`, never a leg.
