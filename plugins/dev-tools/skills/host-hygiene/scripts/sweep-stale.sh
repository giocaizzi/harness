#!/usr/bin/env bash
# sweep-stale.sh [--branches] [--apply]   list (default) or remove stale git worktrees of the current repo
#
# --branches sweeps branches instead: remote branches with no open PR (branches of closed or
# never-opened PRs; GitHub only deletes on merge) and local branches whose upstream is gone.
# It fetches --prune first. Open PRs come from `gh`, or from SWEEP_OPEN_BRANCHES (one name per
# line) when set. --apply deletes them (`git push origin --delete`, `git branch -D`); the default
# branch, the checked-out branches of every worktree and branches that are a base of an open PR
# are never touched.
#
# A worktree is stale only when ALL hold: no file modified in the last 24 h, no process with a
# file or its cwd under it (lsof), no uncommitted changes. The main checkout and the current
# worktree are never touched. Removal is `git worktree remove` (never --force); branches stay.
set -u
apply='' branches=''
for a in "$@"; do
  case $a in --apply) apply=1 ;; --branches) branches=1 ;; *) echo "usage: sweep-stale.sh [--branches] [--apply]" >&2; exit 2 ;; esac
done

sweep_branches() {
  git fetch -q --prune origin || { echo "sweep: fetch failed; nothing changed" >&2; return 1; }
  default=$(git symbolic-ref -q --short refs/remotes/origin/HEAD | sed 's|^origin/||')
  default=${default:-main}
  if [ -n "${SWEEP_OPEN_BRANCHES+x}" ]; then open=$SWEEP_OPEN_BRANCHES
  else open=$(gh pr list --state open --limit 1000 --json headRefName,baseRefName --jq '.[] | .headRefName, .baseRefName') || { echo "sweep: gh pr list failed; nothing changed" >&2; return 1; }
  fi
  # Branches checked out in any worktree are in use.
  held=$(git worktree list --porcelain | sed -n 's|^branch refs/heads/||p')
  git for-each-ref --format='%(refname:lstrip=3)' refs/remotes/origin | grep -v -x -e HEAD -e "$default" |
  while IFS= read -r b; do
    printf '%s\n' "$open" | grep -q -x -F -- "$b" && continue
    if [ -n "$apply" ]; then git push -q origin --delete "$b" && echo "deleted origin/$b"; else echo "would delete origin/$b: no open PR"; fi
  done
  git for-each-ref --format='%(refname:short) %(upstream:track)' refs/heads | sed -n 's/ \[gone\]$//p' |
  while IFS= read -r b; do
    printf '%s\n' "$held" | grep -q -x -F -- "$b" && { echo "keep $b: checked out in a worktree"; continue; }
    if [ -n "$apply" ]; then git branch -q -D "$b" && echo "deleted $b"; else echo "would delete $b: upstream gone"; fi
  done
}
if [ -n "$branches" ]; then sweep_branches; exit $?; fi
command -v lsof >/dev/null || { echo "sweep: lsof not found; cannot tell busy worktrees, nothing removed" >&2; exit 1; }
here=$(cd "$(git rev-parse --show-toplevel)" && pwd -P) || exit 1

git worktree list --porcelain | awk '/^worktree / { sub(/^worktree /, ""); print }' | tail -n +2 |
while IFS= read -r wt; do
  [ -d "$wt" ] || { echo "keep $wt: missing (git worktree prune clears it)"; continue; }
  [ "$(cd "$wt" && pwd -P)" = "$here" ] && { echo "keep $wt: current worktree"; continue; }
  # -mmin behaves the same on BSD and GNU find; -newermt date parsing does not.
  [ -n "$(find "$wt" -mmin -1440 -print 2>/dev/null | head -1)" ] && { echo "keep $wt: modified in the last 24 h"; continue; }
  # lsof exits 1 for "nothing found" and also on harmless warnings: judge by output past the header.
  [ -n "$(lsof +D "$wt" 2>/dev/null | tail -n +2)" ] && { echo "keep $wt: in use by a process"; continue; }
  dirty=$(git -C "$wt" status --porcelain 2>/dev/null) || { echo "keep $wt: git status failed"; continue; }
  [ -n "$dirty" ] && { echo "keep $wt: uncommitted changes"; continue; }
  if [ -n "$apply" ]; then
    git worktree remove "$wt" && echo "removed $wt"
  else
    echo "would remove $wt"
  fi
done
[ -n "$apply" ] && git worktree prune
exit 0
