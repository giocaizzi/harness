# The techniques on each platform

GitHub Actions has its own skill, `github-actions`. For the others, each row names the keywords to look up; check them against the platform's current docs before relying on a detail, since these keys change.

| Technique | GitLab CI | Azure Pipelines | Jenkins (declarative) |
|---|---|---|---|
| Job graph | `needs:` (a DAG across stages) | `dependsOn:` on jobs and stages | `parallel` blocks inside `stages` |
| Parallel inside one job type | `parallel: N` (`CI_NODE_INDEX`, `CI_NODE_TOTAL` pick the shard) | `strategy: parallel: N` (`System.JobPositionInPhase`, `System.TotalJobsInPhase`) | `parallel` branches, one per shard |
| Matrix | `parallel: matrix:` | `strategy: matrix:` with `maxParallel` | `matrix { axes { ... } }` |
| Cancel superseded change runs | `interruptible: true` on jobs, `workflow: auto_cancel: on_new_commit: interruptible` | `pr: autoCancel: true` (the default); `trigger: batch: true` batches mainline runs | `options { disableConcurrentBuilds(abortPrevious: true) }` on change-request jobs only |
| Serialise deploys | `resource_group:` on the deploy job (`process_mode` for the order) | an environment with the **Exclusive lock** check; `lockBehavior: sequential` or `runLatest` | `lock('env-prod') { ... }` (Lockable Resources), `milestone` to drop superseded builds |
| Change detection | `rules: - changes:` (with `compare_to:` in MR pipelines), at the job level | `condition:` on a job reading an output variable a detection job set | `when { changeset '...' }` |
| Cache | `cache: key: files: [lockfile]`; `policy: pull` on change-request jobs, `pull-push` on mainline | `Cache@2` task, key like `'npm \| "$(Agent.OS)" \| package-lock.json'` | a cache plugin, or a shared volume on the agent |
| Hand an artifact on | `artifacts:` + `needs: [{job, artifacts: true}]` | `PublishPipelineArtifact` / `DownloadPipelineArtifact` | `stash` / `unstash`, or `archiveArtifacts` |
| Timeout | `timeout:` per job | `timeoutInMinutes:` per job | `options { timeout(time: N, unit: 'MINUTES') }` |
| Retry infrastructure only | `retry: max: 1, when: [runner_system_failure, stuck_or_timeout_failure]` | `retryCountOnTaskFailure:` on a network-bound step only | `retry(1)` around the network-bound step only |
| Gated merge | merge trains (`CI_MERGE_REQUEST_EVENT_TYPE == "merge_train"`) | build validation branch policy | the forge's merge gate calling the job |
| Environments | `environment:` + protected environments, environment-scoped variables | Environments with approvals and checks, `deployment` jobs | the folder or credential scope per environment, an `input` step for approval |
| Federated identity | `id_tokens:` with an `aud` per cloud | a workload identity federation service connection | the cloud plugin's OIDC support, else short-lived credentials from a vault |

Other platforms (Buildkite, CircleCI, Tekton, Argo Workflows, Woodpecker) have the same building blocks under other names: find each row's equivalent before writing the pipeline, and say in the change which row has none.
