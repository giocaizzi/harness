---
name: ci-cd
description: "How to make any CI/CD pipeline fast, cheap and safe, on any platform (GitHub Actions, GitLab CI, Azure Pipelines, Jenkins, Buildkite, CircleCI): the job graph and critical path, parallel jobs, sharding and matrices, run concurrency and cancellation, deploy locks, caching, change detection, timeouts, retries and flakes, build-once-promote delivery, environments and federated credentials. Use whenever you write, review or debug a pipeline or workflow file (.github/workflows/*.yml, .gitlab-ci.yml, azure-pipelines.yml, Jenkinsfile, .circleci/config.yml, .buildkite/), add a build, test, release or deploy job, or CI is slow, flaky, costly, stuck pending or serial."
---

# CI/CD

The techniques, platform-neutral. Each platform's spelling is in its own place: GitHub Actions in the `github-actions` skill, GitLab CI, Azure Pipelines and Jenkins in [references/platforms.md](references/platforms.md). The repo baseline (one aggregate required `check`, task runner, secret scan) is `repo-standard`. When a repo already has its own pipeline conventions, follow them and propose changes separately.

## The model

A pipeline is a graph of jobs. Two numbers matter and they pull apart:

- **Wall time** is the longest path through the dependency edges: cut it with parallelism.
- **Cost** is the sum of job-minutes, each job rounded up and each paying its fixed setup (runner start, checkout, toolchain, cache restore): cut it by doing less work, and by not splitting work smaller than its setup.

Say which one a change targets, and check the other did not get worse.

## Parallelism within a run

- **Edges only where data or order is real.** A job depends on another only to consume its artifact or because it must come after (deploy after test). Lint, unit tests and the build usually start together.
- **Parallel inside a job first** (the test runner's workers, `make -j`, `go test -p`): it pays setup once. Split into more jobs when one job's work is many times its setup.
- **Build once, fan out.** One job builds the artifact (binary, image, wheel); the jobs after it download it instead of rebuilding.
- **Shard the longest suite** by recorded test timings, not by file count, and run a check that the shards together list exactly the whole suite: a test dropped from every shard is a silent hole.
- **Matrix legs are independent.** `fail-fast` off where each leg's result matters on its own (it saves re-runs); on where one failure makes the rest meaningless.
- **Shared resources serialise "parallel" jobs.** Jobs that hit one database, test account, emulator or rate-limited API flake together: give each its own (a service container, a namespace, a per-job prefix) or put a lock on it.

## Concurrency between runs

Every run is one of three kinds, and each gets its own policy:

| Run | Policy |
|---|---|
| Change request (PR or MR) | A newer push cancels the superseded run of the same change. |
| Gate and mainline (merge queue or train, default branch, release tags) | Never cancelled: a cancelled queue run drops the entry, a cancelled mainline run hides a break. |
| Deploy | Serialised per target environment by a lock keyed on the environment, never on the branch. A running deploy is never cancelled; a newer one may replace a pending one. |

Anything else with shared state (Terraform state, a release, a database migration, a device) takes a lock or a resource group, and every job is safe to re-run.

## Doing less work

- **One full run per tree.** Count every time the same commit is tested (change request, queue, mainline push, nightly) and drop the repeats the gate already covers. Whatever must see the landed commit stays: secret scan, release, deploy.
- **Two tiers.** Light checks on every change-request push (lint, the touched packages' tests); the slow suites (integration, end-to-end, full matrix) where the merge is gated, plus nightly. The trade-off is a later signal: record it in the change that moves a suite.
- **Change detection at the job level.** A detection job computes what changed; heavy jobs skip on its output; one aggregate gate job always runs and accepts a skip only when detection said "not needed". Detection fails closed (an unknown diff means run everything), and gate and mainline runs run everything.
- **Caches** are keyed on the lockfile hash, toolchain version and OS; restored by every run, written only by trusted mainline or scheduled runs; never hold a secret. Cache what is expensive to make and cheap to restore (dependency downloads, compiler caches, image layers: `docker` skill), and watch the hit rate.
- **Fewer runs.** Push a review round as one commit, batch dependency updates weekly, skip CI on draft changes.

## Reliability

- **Timeouts on every job**, from its measured p90 plus headroom, so a hang fails instead of holding the gate.
- **Retry infrastructure, never tests.** A lost runner or a network error is retried, once. A test that passes on retry is a flake: track it (an issue, a `flaky` label) and fix or quarantine it with the owner; never call the run green.
- **Deterministic inputs:** locked dependencies, pinned toolchain, third-party actions, images and plugins pinned by digest or SHA, with an update bot moving the pins.

## Delivery

- **Build once, promote by digest.** The artifact the gate tested is the one each environment deploys; environment config is applied at deploy time, never baked into a rebuild.
- **Environments carry the secrets.** Each deploy runs in a named environment with its own scoped secrets and approvals; nothing deploys with repository-wide credentials.
- **Federated identity over stored keys.** The pipeline's OIDC token is exchanged for short-lived cloud credentials (`terraform` for the cloud side); no long-lived publish or deploy token where the target accepts OIDC.
- **Untrusted code gets no secrets.** Change requests from forks run without secrets and never write a cache that trusted runs restore.
- **Rollback is a redeploy** of the previous artifact. A schema change ships expand/contract so both versions run on it (`system-design`); rollout health gates are in `kubernetes`.

## Measure before and after

Change one lever at a time, and keep it only when equal windows of run history show it helped: wall-time p50 and p90, minutes per merged change, runs per merged change, queue time, re-run and flake rate. The symptom-to-lever table is [references/diagnose.md](references/diagnose.md); GitHub's measurement commands are in `github-actions`.

## Gotchas

- A trigger-level path filter on a workflow that provides a required check leaves that check pending forever when nothing matches: filter at the job level behind the aggregate gate.
- A job skipped by its condition counts as passed on most platforms: a required job that can be skipped needs the aggregate gate to judge the skip.
- A pipeline that commits, tags or edits files it triggers on re-triggers itself: test it on a branch and read the first runs.
- A deploy lock keyed on the branch lets two branches deploy the same environment at once.
- Caches written by change-request runs evict mainline entries and can be poisoned by untrusted code.
- Renaming a job that branch protection requires silently blocks or unblocks every merge: keep required names stable behind the aggregate gate.
