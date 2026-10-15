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

- **CI** with one aggregate required job named `check` (`needs:` every other job, `if: always()`, fails when any of them failed or was cancelled), so matrix or job changes never touch branch protection. Required job names are stable; renaming one silently unblocks or blocks merges.
- **Task runner** exposing `help`, `lint`, `test`, `check` (= lint + test); `make` preferred, else the repo's own runner (`npm run`, `just`, `task`). CI calls the runner, not the tools.
- **Secret scan** in CI (gitleaks).
- **PR title check**: the title is a Conventional Commit (see `conventional-commits`), required next to `check`.
- **Dependency update bot**: Dependabot or Renovate. Always grouped, never one PR per dependency: one group per ecosystem for CI actions and container images; for language packages one `minor-patch` group, one `major` group (breaking changes reviewed apart) and one security-updates group (Dependabot `groups` with `update-types` / `applies-to: security-updates`; Renovate `group:all`-style presets). Set the bot's commit-message prefix so its PR titles pass the title check: `ci(deps)` for CI actions, `chore(deps)` for everything else (Dependabot `commit-message.prefix`; Renovate `commitMessagePrefix` / `semanticCommitType`).
- **`AGENTS.md`** with `CLAUDE.md` symlinked to it. Agent instructions live only there, never in the README.
- **Agent config:** commit shared harness config (`.claude/settings.json`, `.mcp.json`, `.github/copilot/settings.json`, `opencode.json`, `.pi/settings.json`, project agents and skills); the repo's `.gitignore` ignores personal and machine state: `.claude/settings.local.json`, `.claude/worktrees/`, `.claude/agent-memory-local/`, `CLAUDE.local.md`, `.github/copilot/settings.local.json`, `.opencode/node_modules/`, `.opencode/plans/`, `.pi/npm/`, `.pi/git/`.
- **`README.md` for humans**: name, tagline, badges, short description, quickstart, link to `docs/`, license; it never duplicates `docs/`. Badges grow with maturity: every repo gets CI and license; public adds language/tooling (e.g. Ruff); released adds the release badge (PyPI version and Python versions for packages); a live docs site or coverage adds Docs and Coverage badges.
- **Squash-only merge**, commit built from the PR title and body; **delete the branch on merge**.
- **Protected default branch**: changes only via PR, requires `check` + the title check, no bypass for anyone.
- **`SECURITY.md`**, issue templates, and a `LICENSE` on public repos.
- **Python uses uv**, never poetry (unless the repo already does; see the rule above).
- **Publish and deploy jobs run in a named environment** (`pypi`, `production`, ...) and read environment-scoped secrets, never repository-wide ones. Where the plan offers no environments (e.g. private GitHub repos on the free plan), say so as a gap.
- **No long-lived publish tokens when OIDC exists**: publish packages with trusted publishing (PyPI: GitHub Actions or GitLab CI, `id-token: write`, no token) from the release.

Roll out lowest risk first: settings, CI with `check`, and only then the protection that requires it. Protection requiring a check that does not exist blocks every merge.

## By repo type

| Repo has | Add |
|---|---|
| Code | Tests in CI (`test` target). |
| Python | uv, ruff, mypy, pytest (see `python-development`). |
| TypeScript | the repo's package manager, typecheck + lint + tests (see `javascript-typescript`). |
| `Dockerfile` | hadolint in `lint`. |
| Infrastructure | validate in `lint` (`terraform validate`, `bicep build`, `helm lint`). |
| Releases | release-please; the changelog comes from it (see `release-please`). Package publishing is triggered by the release, in its environment. |
| Coverage | Codecov or similar, informational only, never a required check. |

Optional: pre-commit (mirrors `make lint`, never replaces CI), `CODEOWNERS`.

## Forge mapping

| | GitHub | GitLab | Azure DevOps |
|---|---|---|---|
| CLI | `gh` | `glab` | `az repos`, `az pipelines` (`azure-devops` extension) |
| Change request | pull request (PR) | merge request (MR) | pull request (PR) |
| Open | `gh pr create --title T --body B` | `glab mr create --title T --description B --squash-before-merge --remove-source-branch` | `az repos pr create --title T --description B` (`-t` is the target branch, not the title) |
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
