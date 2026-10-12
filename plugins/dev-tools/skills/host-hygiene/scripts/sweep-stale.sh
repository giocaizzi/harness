#!/usr/bin/env bash
# sweep-stale.sh [--apply]   list (default) or remove stale git worktrees of the current repo
#
# A worktree is stale only when ALL hold: no file modified in the last 24 h, no process with a
# file or its cwd under it (lsof), no uncommitted changes. The main checkout and the current
# worktree are never touched. Removal is `git worktree remove` (never --force); branches stay.
set -u
apply=''
[ "${1:-}" = --apply ] && apply=1
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
