#!/usr/bin/env bash
# sweep-stale.sh [--branches | --plugins] [--apply]   list (default) or remove stale git worktrees of the current repo
#
# --plugins sweeps the Claude Code plugin cache instead: version dirs under
# ${CLAUDE_CONFIG_DIR:-~/.claude}/plugins/cache/<marketplace>/<plugin>/<version> that are not the
# installPath of any entry in plugins/installed_plugins.json (any scope) and that no process uses
# (lsof: an open file or cwd under it; ps: a command line naming it). An unreadable
# installed_plugins.json, or no jq or lsof, removes nothing. --apply removes them (`rm -rf`).
# A running session keeps the version it loaded until /reload-plugins, which the sweep cannot see.
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
# It also lists dirs under the worktrees root (the main checkout's .claude/worktrees, or
# SWEEP_WORKTREES_ROOT when the repo's AGENTS.md puts worktrees elsewhere) that git no longer
# registers, typically a remove that failed on read-only build files, with their size and the
# command that reclaims them. It never runs that command, even with --apply.
set -u
apply='' branches='' plugins=''
usage() { echo "usage: sweep-stale.sh [--branches | --plugins] [--apply]" >&2; exit 2; }
for a in "$@"; do
  case $a in --apply) apply=1 ;; --branches) branches=1 ;; --plugins) plugins=1 ;; *) usage ;; esac
done
[ -n "$branches" ] && [ -n "$plugins" ] && usage

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
sweep_plugins() {
  local root=${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins
  command -v jq >/dev/null || { echo "sweep: jq not found; nothing removed" >&2; return 1; }
  command -v lsof >/dev/null || { echo "sweep: lsof not found; cannot tell busy versions, nothing removed" >&2; return 1; }
  [ -d "$root/cache" ] || { echo "sweep: no plugin cache at $root/cache"; return 0; }
  local installed procs real
  installed=$(jq -r '.plugins[][] | .installPath // empty' "$root/installed_plugins.json") ||
    { echo "sweep: cannot read $root/installed_plugins.json; nothing removed" >&2; return 1; }
  # Compare resolved paths: the recorded installPath may go through a symlink (/tmp, a moved home).
  installed=$(printf '%s\n' "$installed" | while IFS= read -r p; do [ -d "$p" ] && (cd "$p" && pwd -P); done)
  procs=$(ps -axo command= 2>/dev/null)
  for dir in "$root"/cache/*/*/*/; do
    [ -d "$dir" ] || continue
    real=$(cd "$dir" && pwd -P) || continue
    printf '%s\n' "$installed" | grep -q -x -F -- "$real" && { echo "keep $real: installed"; continue; }
    # lsof exits 1 for "nothing found" and also on harmless warnings: judge by output past the header.
    [ -n "$(lsof +D "$real" 2>/dev/null | tail -n +2)" ] && { echo "keep $real: in use by a process"; continue; }
    printf '%s\n' "$procs" | grep -q -F -- "$real/" && { echo "keep $real: named by a running command"; continue; }
    if [ -n "$apply" ]; then
      rm -rf -- "$real" && echo "removed $real"
      rmdir -- "$(dirname "$real")" 2>/dev/null
    else
      echo "would remove $real"
    fi
  done
}
if [ -n "$branches" ]; then sweep_branches; exit $?; fi
if [ -n "$plugins" ]; then sweep_plugins; exit $?; fi
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

main=$(git worktree list --porcelain | awk '/^worktree / { sub(/^worktree /, ""); print; exit }')
root=${SWEEP_WORKTREES_ROOT:-$main/.claude/worktrees}
if [ -d "$root" ]; then
  registered=$(git worktree list --porcelain | awk '/^worktree / { sub(/^worktree /, ""); print }' |
    while IFS= read -r wt; do [ -d "$wt" ] && (cd "$wt" && pwd -P); done)
  for d in "$root"/*/; do
    [ -d "$d" ] || continue
    real=$(cd "$d" && pwd -P) || continue
    printf '%s\n' "$registered" | grep -q -x -F -- "$real" && continue
    [ -n "$(lsof +D "$real" 2>/dev/null | tail -n +2)" ] && { echo "keep $real: unregistered but in use by a process"; continue; }
    echo "unregistered $real ($(du -sh "$real" 2>/dev/null | cut -f1)): the owner runs chmod -R u+w '$real' && rm -rf '$real'"
  done
fi
exit 0
