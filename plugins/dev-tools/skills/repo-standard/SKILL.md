---
name: repo-standard
description: The baseline every repository should meet (CI with one aggregate `check`, task runner, secret scan, PR title check, update bot, protected default branch, squash merge) and how each practice maps onto GitHub, GitLab and Azure DevOps. Use when setting up or auditing a repo, opening or merging a PR/MR on any forge, or deciding which convention applies in a repo that has its own.
---

# Repo standard

## Rule: detect, apply where possible, never force

1. **Detect the forge** from `git remote get-url origin`: `github.com` → GitHub, `gitlab.` in the host → GitLab, `dev.azure.com` or `*.visualstudio.com` → Azure DevOps. Use that forge's CLI from the mapping below.
2. **Apply each practice where the platform and the repo allow it.** A plan or permission that lacks a feature (no rulesets, no approval rules) is a gap to report, not a reason to bypass.
3. **The repo's own convention wins.** If the repo or its org already has one (another commit style, pip or poetry, no Makefile, a different CI layout), follow it and say so in the PR. Propose the standard separately; never convert a repo as a side effect.

## Checklist (every repo)

- **CI** with one aggregate required job named `check` (`needs:` every other job, `if: always()`, fails when any of them failed or was cancelled, and on any skip outside an explicit per-job, per-event allowlist or a `changes` job's "not needed"), so matrix or job changes never touch branch protection. Required job names are stable; renaming one silently unblocks or blocks merges.
- **CI hygiene and cost**: every job has `timeout-minutes`; `concurrency` cancels superseded `pull_request` runs only, never `merge_group` or default-branch runs; required workflows also trigger on `merge_group` where a merge queue exists. Each change is tested on the PR, in the queue and on the push to the default branch, so with a merge queue that every change must pass (the ruleset requires it, with an empty bypass list) the `merge_group` run is the full gate and the push runs only what needs the landed commit (the secret scan, release and deploy jobs and everything they depend on); without one the push run is the gate and keeps the full suite (the exception for a ruleset that requires up-to-date branches is in `github-actions`). Heavy jobs (multi-arch image builds, emulator suites) are gated by a `changes` job and skipped at the job level, never by workflow-level path filters, so the aggregate `check` always reports. Never traded for minutes: the secret scan, the aggregate `check` on every PR and queue run (and on the push where a release or deploy waits on it), and anything a release depends on. The techniques on any platform: `ci-cd`; the GitHub spelling and measuring Actions minutes: `github-actions`.
- **CI tiers, drafts and the local gate**: with that merge queue, a light tier on every PR push (secret scan, a `changes` job, lint, the touched packages' tests) and a full tier (integration, end-to-end, release dry-run, coverage floor) on `merge_group` and an opt-in `workflow_dispatch`, with a repository variable that puts the full tier back on PR runs as a rollback. Drafts run no CI, and a skipped draft run never reports the required `check`. A task-runner `prepush` target (`check` itself where there are no tiers) is the local gate an agent passes before marking a PR ready, once. Details in `github-actions` (CI for a gate: checklist).
- **Task runner** exposing `help`, `lint`, `test`, `check` (= lint + test); `make` preferred, else the repo's own runner (`npm run`, `just`, `task`). CI calls the runner, not the tools.
- **Secret scan** in CI (gitleaks).
- **PR title check**: the title is a Conventional Commit (see `conventional-commits`), required next to `check`.
- **Dependency update bot**: Dependabot or Renovate. Always grouped, never one PR per dependency: one group per ecosystem for CI actions and container images; for language packages one `minor-patch` group, one `major` group (breaking changes reviewed apart) and one security-updates group (Dependabot `groups` with `update-types` / `applies-to: security-updates`; Renovate `group:all`-style presets). Batched in time too: a weekly schedule (Dependabot `schedule.interval: weekly`; Renovate `schedule`) and a cap on open update PRs (Dependabot `open-pull-requests-limit`; Renovate `prConcurrentLimit`), since every update PR pays a full set of CI runs; security updates are not held to the schedule (Dependabot raises them as advisories appear). Set the bot's commit-message prefix so its PR titles pass the title check: `ci(deps)` for CI actions, `chore(deps)` for everything else (Dependabot `commit-message.prefix`; Renovate `commitMessagePrefix` / `semanticCommitType`).
- **CI actions pinned by SHA**: third-party actions are pinned by full commit SHA with a version comment (`uses: actions/checkout@<sha> # v5`), and the update bot updates those pins. A tag or branch ref left in place is a supply-chain security gap, not a speed lever.
- **Labels from one allowlist**: the standard defines the labels every repo has (type, priority, the ones bots create); a repo declares its own extras in a committed labels file (same format, never redefining a standard name). Sync creates both and deletes any other label; an event-driven guard deletes a stray label as soon as it is created, since no forge blocks label creation. GitLab: group-level labels, a repo-only label at project level. Azure DevOps has no labels on work items; tags are free-form, so this is a gap.
- **TODO tracking**: a workflow on pushes to the default branch turns each new `TODO` comment into an issue labelled `todo` and closes it when the comment goes; one manual run over the whole history imports the TODOs a repo already has, deduplicated by title.
- **`AGENTS.md`**, and no `CLAUDE.md`: Claude Code reads `AGENTS.md` when no `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` exists in that directory or above, and the other harnesses read it natively. Agent instructions live only there, never in the README.
- **No installs into the worktree:** no make target or CI step installs tools, binaries or browsers inside the checkout; they go to a per-user, version-keyed store reached by the same path logic locally and in CI, and a worktree holds only source plus build output that is cheap to regenerate (`host-hygiene`, Shared stores).
- **Agent config:** commit shared harness config (`.claude/settings.json`, `.mcp.json`, `.github/copilot/settings.json`, `opencode.json`, `.pi/settings.json`, project agents and skills); the repo's `.gitignore` ignores personal and machine state: `.claude/settings.local.json`, `.claude/worktrees/`, `.claude/agent-memory-local/`, `CLAUDE.local.md`, `.github/copilot/settings.local.json`, `.opencode/node_modules/`, `.opencode/plans/`, `.pi/npm/`, `.pi/git/`.
- **MCP servers, least privilege:** everything starts off; a session sees only the servers its repo needs. No per-repo disable lists: a server a repo has to turn off belongs in a narrower layer. Where a server goes:
  1. **User scope** (dotfiles): only servers every repo needs; account-synced connectors off where the harness allows it (Claude Code: `disableClaudeAiConnectors: true`).
  2. **The repo** (committed, the default): every server anyone working on the repo needs (other machines, collaborators, cloud agents), in each harness's project file with the same server names: `.mcp.json` (Claude Code, Copilot CLI), `.vscode/mcp.json` (VS Code), `.codex/config.toml` (Codex), `opencode.json` (opencode), `.pi/mcp.json` (pi). Files, keys and secret syntax per harness: [compatibility.md](https://github.com/giocaizzi/harness/blob/main/docs/compatibility.md#mcp-servers).
  3. **A workspace folder** (dotfiles): personal servers tied to no repo get their own folder with a project file, and the session starts there. Never in the home directory or a parent of repos: Claude Code merges every parent folder's `.mcp.json` into each repo below it.
  4. **Trial** (machine-only, uncommitted; Claude Code: `claude mcp add -s local`, elsewhere a gitignored project file or a per-run override, per compatibility.md): try a server first, then promote it to 1, 2 or 3, or remove it.
  - Config holds names and URLs only: secrets, and private parts of a URL (an account, an internal host), come from the environment through each harness's reference syntax, never inlined; where a harness cannot expand a URL, its file is rendered outside the repo. Remote servers prefer OAuth (each user signs in).
  - A connector that exists only in an account (e.g. claude.ai) may refuse a direct sign-in from a CLI: try it as a trial, and if it fails, use it from that account's own apps.
  - The repo's own convention wins (e.g. an org that keeps MCP config out of the repo).
- **`README.md` for humans**: name, tagline, badges, short description, quickstart, link to `docs/`, license; it never duplicates `docs/`. Badges grow with maturity: every repo gets CI and license; public adds language/tooling (e.g. Ruff); released adds the release badge (PyPI version and Python versions for packages); a live docs site or coverage adds Docs and Coverage badges.
- **Squash-only merge**, commit built from the PR title and body; **delete the branch on merge**.
- **Protected default branch**: changes only via PR, requires `check` + the title check, no bypass for anyone. These are a minimum: a repo may require more (e.g. a leak check), and an audit or re-apply must keep them, not flag or overwrite them.
- **`SECURITY.md`**, issue templates, and a `LICENSE` on public repos.
- **Dev mode:** a component with a dev mode follows `references/dev-mode.md`.
- **Python uses uv**, never poetry (unless the repo already does; see the rule above).
- **Publish and deploy jobs run in a named environment** (`pypi`, `production`, ...) and read environment-scoped secrets, never repository-wide ones. Where the plan offers no environments (e.g. private GitHub repos on the free plan), say so as a gap.
- **No long-lived publish tokens when OIDC exists**: publish packages with trusted publishing (PyPI: GitHub Actions or GitLab CI, `id-token: write`, no token) from the release.

Roll out lowest risk first: settings, CI with `check`, and only then the protection that requires it. Protection requiring a check that does not exist blocks every merge.

## By repo type

| Repo has | Add |
|---|---|
| Code | Tests in CI (`test` target). |
| Python | uv, ruff, mypy, pytest (see `python-development`). |
| Go | `go tool` dependencies, golangci-lint v2, govulncheck, `go test -race` (see `go-development`). |
| TypeScript | the repo's package manager, typecheck + lint + tests (see `javascript-typescript`). |
| `Dockerfile` | hadolint in `lint`. |
| Infrastructure | validate in `lint` (`terraform validate`, `bicep build`, `helm lint`). |
| Releases | release-please; the changelog comes from it (see `release-please`). Package publishing is triggered by the release, in its environment. |
| Coverage | Codecov or similar, informational only, never a required check; a floor, where a repo wants one, lives inside `make test` as a ratchet that may only rise. |

Optional: pre-commit (mirrors `make lint`, never replaces CI), `CODEOWNERS`.

## Forge mapping

| | GitHub | GitLab | Azure DevOps |
|---|---|---|---|
| CLI | `gh` | `glab` | `az repos`, `az pipelines` (`azure-devops` extension) |
| Change request | pull request (PR) | merge request (MR) | pull request (PR) |
| Open (draft first) | `gh pr create --draft --title T --body B` | `glab mr create --draft --title T --description B --squash-before-merge --remove-source-branch` | `az repos pr create --draft true --title T --description B` (`-t` is the target branch, not the title) |
| Ready | `gh pr ready <n>` | `glab mr update <n> --ready` | `az repos pr update --id N --draft false` |
| Watch CI | `gh pr checks --watch` | `glab ci status --live`, logs `glab ci trace <job>` | `az repos pr policy list --id N`, `az pipelines runs list --branch <branch>` |
| Review threads | `gh api graphql` (`reviewThreads`) | `glab mr view --unresolved` | `az devops invoke --area git --resource pullRequestThreads` |
| Merge gating | ruleset on the default branch (see `github-workflow`) | protected branch (no direct push) + **Pipelines must succeed** + approval rules | branch policies: build validation, reviewers, comment resolution |
| Auto-merge | `gh pr merge --auto --squash` | `glab mr merge --auto-merge --squash --remove-source-branch` | `az repos pr update --id N --auto-complete true --squash true --delete-source-branch true` |
| Squash only | repo settings: squash only, commit from PR title and body (exact settings in `conventional-commits`) | Settings > Merge requests: squash **Require**, squash template `%{title}` + `%{description}` | branch policy **Limit merge types**: squash only |
| Title check | `pull_request` workflow job (types include `edited`) reading the title from an env var | MR pipeline job (`$CI_PIPELINE_SOURCE == "merge_request_event"`) reading `$CI_MERGE_REQUEST_TITLE`; editing the title does not rerun it, so rerun the pipeline | build validation pipeline reading the title with `az repos pr show --id $(System.PullRequest.PullRequestId)`; rerun after a title edit |
| Required job | the `check` job name in the ruleset | every job of the MR pipeline must pass, so `check` is a convention, not a setting | one build validation policy per pipeline; gate on the pipeline that runs `check` |
| Environments | Settings > Environments; job `environment:`; environment secrets | Deployment environments (job `environment:`); protected environments; variables scoped to an environment | Pipelines > Environments; `deployment` job with `environment:`; approvals and checks on the environment |
| Bypass to avoid | `--admin` | merging with a failed pipeline, unprotecting the branch | `--bypass-policy true` |

Example of one standard kept for many repos: `giocaizzi/.github` (`docs/standard.md`, ruleset JSON and an audit script).
