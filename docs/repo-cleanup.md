# Repo cleanup and push safety

Runbook for the branch lifecycle: how worktrees, branches and stashes get cleaned up, how to run the sweep by hand, how to undo it, and how every push is scanned for secrets. The rule itself lives in one place, the `github-workflow` skill's "Branch lifecycle" section ([source](https://github.com/giocaizzi/harness/blob/main/plugins/dev-tools/skills/github-workflow/SKILL.md)); this page only covers operating it. Guard internals: [guard.md](guard.md).

In one line: origin holds the work, and a local branch, worktree or stash is a disposable copy. Every commit is pushed at once, a draft PR opens on the first push, and a local copy goes as soon as origin has it.

## What the session sweep does

At session start, in a main checkout, at most once a day, the `guard` plugin spawns dev-tools' `repo-sweep.mjs --auto` for the repo (it only spawns; it never delays the session). The sweep applies the lifecycle:

| Item | Result |
|---|---|
| Local branch origin already holds (pushed, inside a merged PR's head, or archived), clean worktree idle 24 h | Worktree and branch removed. Ignored files go with the worktree (build output, caches), except that an ignored file that looks like a secret (`.env*`, `*secret*`, `*.key`, also inside an ignored directory) keeps the worktree and lists it. |
| Local branch never pushed, no PR, idle 7 days, clean | Scanned with gitleaks, pushed to `refs/archive/<branch>/<yyyymmdd>-<sha12>`, then removed. A scan hit keeps it local and listed. |
| Stash older than 7 days | Archived like a branch (`refs/archive/stash/...`), then dropped. |
| Remote branch of a merged PR, still there | Deleted. |
| Remote branch of a PR closed unmerged, idle 7 days, tip equal to (or inside) the closed PR's head | Deleted; its commits stay at `refs/pull/<n>/head`. Only PRs authored by the logged-in gh user, unless `--remote-scope all` or `SWEEP_REMOTE_SCOPE=all`. A branch name reused after the PR closed (the tip differs) is listed, not deleted. |
| Remote branch with no PR | Listed. With `--remote-scope all`, deleted when its content is proven landed on the default branch. |
| Archive ref older than 90 days (`SWEEP_ARCHIVE_DAYS`) | Deleted. |
| Anything else (younger than 24 h, dirty, in use, checked out in the main checkout or the current worktree, open PR head or base on origin, bot branch, default branch) | Kept, and listed with the reason when it is not on origin. |

Every delete compares the tip it saw with the tip it removes, so a branch that moved in between is kept and logged `moved`. The next session shows the summary once (`sweep: removed 12 local branches, 3 worktrees; archived 2; ...; log <path>`). Without dev-tools installed the guard only counts and nudges when a repo has over 10 worktrees, 50 local branches or 3 stashes.

On GitHub the sweep does everything above. On other forges (GitLab, Azure DevOps) it handles locals and archives only and never deletes a remote branch.

## Run it by hand

The script is `skills/host-hygiene/scripts/repo-sweep.mjs` in dev-tools (the installed plugin, or a checkout). Dry run first, read the table, then apply:

```bash
node <dev-tools>/skills/host-hygiene/scripts/repo-sweep.mjs            # dry run: what would be deleted, archived, listed
node <dev-tools>/skills/host-hygiene/scripts/repo-sweep.mjs --apply    # do it
node <dev-tools>/skills/host-hygiene/scripts/repo-sweep.mjs --json     # machine-readable
```

Compare the dry run with `git worktree list`, `git branch -vv` and `gh pr list --state all` when the repo is unfamiliar. State lives in `<git-common-dir>/sweep/` (`stamp`, `log.jsonl`, `last.json`).

Other directories to inspect: the sweep looks at `<main>/.claude/worktrees`, each worktree's own `.claude/worktrees` and every path in `SWEEP_WORKTREES_ROOT` (a path list; set it when the repo's `AGENTS.md` puts worktrees elsewhere). A directory there that git no longer registers is listed with its size and the command to remove it; the sweep never removes those itself.

Opt out of the session sweep and the stop reminder with `GUARD_LIFECYCLE=off` in the launching environment (also set by `make test`, and needed when probing a harness from a checkout).

## Shared stores (low disk)

When the disk runs low, `node <dev-tools>/skills/host-hygiene/scripts/repo-sweep.mjs --stores` (add `--json` for a machine-readable report) prints the free space against the floor (`HOST_DISK_FLOOR_GB`, default 20), then each per-user shared store (Go, npm, pnpm, uv, Cargo, Playwright and other caches) with its path, size and the command that trims it, largest first. It needs no git repo, deletes nothing, and is a usage error with `--apply`, `--auto` or `--remote-scope`.

Trim a store with its own command, as printed (for example `go clean -cache` or `uv cache prune`), never with `rm -rf`. The rule and the per-ecosystem table live in the host-hygiene skill's [shared-stores reference](https://github.com/giocaizzi/harness/blob/main/plugins/dev-tools/skills/host-hygiene/references/shared-stores.md). Worktrees are never deleted to free space: the branch lifecycle above decides those.

## Restore

Every deleted branch, archive and stash is on origin first, so its restore is a fetch. Ignored files removed with a worktree (build output, caches) are not kept anywhere: regenerate them.

1. Find the entry in `<git-common-dir>/sweep/log.jsonl`: each line is `{time, kind, name, oid, reason, restore}`.
2. Run its `restore` command: `git fetch origin <ref>` then `git branch <name> <oid>`.
3. For an archived branch or stash the ref is under `refs/archive/`. List what is there: `git ls-remote origin 'refs/archive/*'`. Archives expire after 90 days; after that only a PR ref (`refs/pull/<n>/head`) can still hold the commits.

A remote branch deleted as stale is restored from its PR: `git fetch origin refs/pull/<n>/head` then `git branch <name> FETCH_HEAD` and `git push origin <name>`.

## Push safety

A secret that reaches origin stays reachable through PR refs, forks and clones even after the branch is fixed or deleted, so every push is scanned before it leaves the machine. Three layers:

1. **The guard** (agents): a `git push`, or a command that may push (`gh pr create`, `gh stack submit`, `glab mr create`, `az repos pr create`), runs gitleaks over the commits origin does not have yet and is denied on a finding ([guard.md](guard.md#decisions), Push scan). gitleaks missing or slow asks. `GUARD_PUSH_SCAN=off` disables it for tests and probes only. `git push --no-verify` asks, since it would skip layer 2.
2. **A global pre-push hook** (every push by any tool, humans included). A dotfiles setup installs it with `core.hooksPath` pointing at a hooks directory. Because a global `core.hooksPath` replaces `.git/hooks` for every hook name, that directory holds one dispatcher per standard client hook that runs the repo's own hook from `$(git rev-parse --git-common-dir)/hooks/<name>` when it exists and is executable; the `pre-push` dispatcher runs the scan first, then chains. It skips deletes, scans `<remote sha>..<local sha>` (or the new ref minus the remote's refs), and fails closed when gitleaks is missing. A repo that sets its own local `core.hooksPath` (husky, lefthook) overrides the global one: there this layer does not run and only the guard covers agents.
3. **A private-name pass on public repos** (optional). When `GITLEAKS_PRIVATE_CONFIG` names a gitleaks config of names that must not reach a public repo (private org, repo and host names), pushes to a public repo (or one whose visibility is unknown) get a second scan with it. The harness ships no patterns; keep that config outside any public repo.

### On a finding

1. Do not bypass the scan.
2. Remove the secret from the unpushed commits (amend or rebase them; they are not on origin yet), then push again.
3. Rotate the secret if it was ever shared or typed into a place that syncs.
4. A false positive: add its fingerprint to the repo's `.gitleaksignore` in the PR, reviewed like code.

### After a bad push

If a secret did reach origin, deleting or rewriting the branch does not remove it: `refs/pull/<n>/head`, forks, clones and caches keep it reachable. Rotate the secret first, then clean the branch. A private name that reached a public repo cannot be taken back; describe things in their own terms (`acme/app`) from then on.

## Draft PRs and CI cost

Pushing every commit opens a draft PR on the first push. Under the repo standard, drafts run no CI, so a draft push is a free backup. A repo without that gate pays one CI run per push; it adds the draft gate ([github-workflow skill](https://github.com/giocaizzi/harness/blob/main/plugins/dev-tools/skills/github-workflow/SKILL.md), "Drafts run no CI").

## Stale PRs and issues

Each repo's stale workflow (`actions/stale`, from the repo template and the standard) closes idle PRs and issues; the numbers and exemptions are in the `github-workflow` skill's "Branch lifecycle". It feeds the branch sweep: a PR closed as stale is a PR closed unmerged, so its remote branch goes after 7 idle days, and its commits stay at `refs/pull/<n>/head`.
