---
name: land
description: Wait for CI on a PR, fix trivial failures, merge it through auto-merge or the merge queue, then sync main, remove the branch and worktree, and verify the change works where it lands. Use when the user asks to merge, land or verify a PR, or types /land or /verify (optionally a PR number).
---

# Land

Take an open PR (GitLab: MR) to merged and clean. Argument (`$ARGUMENTS`, or the text after the skill name where that placeholder is left as is): a PR number; default is the current branch's PR. Detect the forge and take its commands from the `repo-standard` mapping; on GitHub also follow `github-workflow`.

1. **Watch CI** (GitHub `gh pr checks --watch`, GitLab `glab ci status --live`, Azure DevOps `az repos pr policy list`). On failure, fix lint or format problems with a new commit and push; for anything else, stop and report the failing job and its log.
2. **Merge only when every check passed.** Never merge on a failing or missing check, even if branch protection would not stop you; a red check on `main` is fixed first, in its own PR.
3. **Merge without bypassing** through the forge's auto-merge (`gh pr merge --auto --squash`, `glab mr merge --auto-merge --squash`, `az repos pr update --auto-complete true --squash true`), or enqueue when a merge queue exists. Never use `--admin`, `--bypass-policy` or disable a rule.
4. **Keep stacked children alive:** if other PRs are based on this branch, do not delete it (`gh pr list --base <branch>`, `glab mr list --target-branch <branch>`, `az repos pr list --target-branch <branch>`); a forge may close PRs whose base disappears. Retarget them first.
5. **Wait until merged**, then `git pull --ff-only` on the default branch.
6. **Clean up:** delete the local branch, `git worktree remove` this task's worktree, `git worktree prune`.
7. **Verify where it lands.** Merged is not working: wait for whatever the merge triggers, then prove the change took effect with one check that reads the real target, not the repo. For example:
   - a deployed service: the deploy or release run finished green, then its health endpoint or service status;
   - dotfiles: `chezmoi diff` is empty after apply, and the changed line is in the rendered file;
   - a plugin or extension: the marketplace or package update ran, and the installed version is the new one;
   - a library: the release and tag exist with the new version.
   When the check needs access you lack or a step the user runs, say so and give the exact command.

Report the merge commit, the verify evidence (command and result) or what was skipped and why, and anything left behind.
