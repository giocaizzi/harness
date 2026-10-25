#!/usr/bin/env bash
# sweep-stale.sh [--branches | --plugins [--marketplace <name>] [--after-reload]] [--apply]   list (default) or remove stale git worktrees of the current repo
#
# --plugins sweeps the Claude Code plugin cache instead: version dirs under
# ${CLAUDE_CONFIG_DIR:-~/.claude}/plugins/cache/<marketplace>/<plugin>/<version> that are not the
# installPath of any entry in plugins/installed_plugins.json (any scope) and that nothing may still
# run. A running session loaded its plugins at start and spawns hooks from that path later without
# holding it open, so a version is kept while any Claude Code process (found by its command line) started before the plugin's
# newest lastUpdated (or while any runs, for a plugin with no entry left), besides lsof (an open
# file or cwd under it) and ps (a command line naming it). /reload-plugins does not restart the
# process, so only the user can tell the sweep that every session reloaded: --after-reload drops
# that keep. Session start times come from ps, or SWEEP_SESSION_STARTS (epoch seconds, one per
# line) when set. An unreadable installed_plugins.json, no jq, lsof or ps, or a failing ps removes
# nothing. A linked marketplace or plugin dir is kept whole; a linked version dir loses only its link.
# --marketplace <name> sweeps only cache/<name>, leaving every other marketplace's versions alone.
# --apply removes them (`rm -rf`).
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
apply='' branches='' plugins='' after_reload='' marketplace=''
usage() { echo "usage: sweep-stale.sh [--branches | --plugins [--marketplace <name>] [--after-reload]] [--apply]" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case $1 in
    --apply) apply=1 ;; --branches) branches=1 ;; --plugins) plugins=1 ;; --after-reload) after_reload=1 ;;
    --marketplace)
      # One dir name under the cache: an empty, path-like or option-like name is a usage error, never "all of them".
      case ${2-} in '' | -* | . | .. | */* | *\\*) usage ;; esac
      marketplace=$2; shift ;;
    *) usage ;;
  esac
  shift
done
[ -n "$branches" ] && [ -n "$plugins" ] && usage
[ -n "$after_reload" ] && [ -z "$plugins" ] && usage
[ -n "$marketplace" ] && [ -z "$plugins" ] && usage

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
  command -v ps >/dev/null || { echo "sweep: ps not found; cannot tell running sessions, nothing removed" >&2; return 1; }
  [ -d "$root/cache" ] || { echo "sweep: no plugin cache at $root/cache"; return 0; }
  local mkts=("$root"/cache/*/)
  if [ -n "$marketplace" ]; then
    [ -d "$root/cache/$marketplace" ] || { echo "sweep: no marketplace $marketplace in $root/cache"; return 0; }
    mkts=("$root/cache/$marketplace/")
  fi
  local installed updated starts procs table entry real key upd n m p
  installed=$(jq -r '.plugins[][] | .installPath // empty' "$root/installed_plugins.json") ||
    { echo "sweep: cannot read $root/installed_plugins.json; nothing removed" >&2; return 1; }
  # <plugin>@<marketplace> TAB the newest lastUpdated (or installedAt) of its entries, as epoch seconds.
  updated=$(jq -r '.plugins | to_entries[] | "\(.key)\t\([.value[] | (.lastUpdated // .installedAt // empty) | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601] | max // "")"' "$root/installed_plugins.json") ||
    { echo "sweep: cannot read the update times in $root/installed_plugins.json; nothing removed" >&2; return 1; }
  if [ -n "${SWEEP_SESSION_STARTS+x}" ]; then starts=$SWEEP_SESSION_STARTS
  else
    # A session is any process whose command line is Claude Code: a `claude` executable, a versioned binary
    # under .../claude/versions/ (comm is then just the version), or an npm install run by node. The patterns
    # run on the whole command line, since argv[0] may hold spaces; a false match only keeps a version longer.
    # etime is [[dd-]hh:]mm:ss on BSD and GNU ps alike; start = now - elapsed, and an unreadable etime counts
    # as 0 (started before every update), so doubt keeps the version. ps runs on its own, so its failure
    # (busybox ps rejects -axo) stops the sweep instead of reading as "no sessions".
    table=$(ps -axo etime=,command=) || { echo "sweep: ps failed; cannot tell running sessions, nothing removed" >&2; return 1; }
    starts=$(printf '%s\n' "$table" | awk -v now="$(date +%s)" '{ c = substr($0, index($0, $1) + length($1)) }
      c ~ /(^|[ \/])claude( |$)/ || c ~ /\/claude\/versions\// || c ~ /@anthropic-ai\/claude-code/ {
      d = 0; t = $1; if (index(t, "-")) { d = substr(t, 1, index(t, "-") - 1); t = substr(t, index(t, "-") + 1) }
      n = split(t, p, ":"); s = p[n] + 60 * p[n - 1] + (n == 3 ? 3600 * p[1] : 0) + 86400 * d
      print ($1 ~ /^([0-9]+-)?[0-9:]+$/ && n >= 2) ? now - s : 0 }')
  fi
  # Compare resolved paths: the recorded installPath may go through a symlink (/tmp, a moved home).
  installed=$(printf '%s\n' "$installed" | while IFS= read -r p; do [ -d "$p" ] && (cd "$p" && pwd -P); done)
  procs=$(ps -axo command=) || { echo "sweep: ps failed; cannot tell running commands, nothing removed" >&2; return 1; }
  # Never descend through a link: a linked marketplace or plugin dir is kept whole, since its grandchildren
  # live outside the cache.
  for m in "${mkts[@]}"; do
    [ -L "${m%/}" ] && { echo "keep ${m%/}: a link; the sweep never follows links above a version"; continue; }
    for p in "$m"*/; do
      [ -L "${p%/}" ] && { echo "keep ${p%/}: a link; the sweep never follows links above a version"; continue; }
      for dir in "$p"*/; do
        sweep_plugin_version "${dir%/}"
      done
    done
  done
}
# One version dir: entry is the cache path, which is what gets removed (a symlinked version dir loses its
# link, never its target); real is only for comparing and probing.
sweep_plugin_version() {
  entry=$1
  [ -d "$entry" ] || return 0
  real=$(cd "$entry" && pwd -P) || return 0
  printf '%s\n' "$installed" | grep -q -x -F -- "$real" && { echo "keep $entry: installed"; return 0; }
  if [ -z "$after_reload" ]; then
    key="$(basename "$(dirname "$entry")")@$(basename "$(dirname "$(dirname "$entry")")")"
    upd=$(printf '%s\n' "$updated" | awk -F '\t' -v k="$key" '$1 == k { print $2 }')
    n=$(printf '%s\n' "$starts" | awk -v u="${upd:-}" 'NF && (u == "" || $1 < u) { c++ } END { print c + 0 }')
    [ "$n" -gt 0 ] && { echo "keep $entry: $n sessions started before the update; reload them first, then --after-reload"; return 0; }
  fi
  printf '%s\n' "$procs" | grep -q -F -e "$entry/" -e "$real/" && { echo "keep $entry: named by a running command"; return 0; }
  # lsof exits 1 for "nothing found" and also on harmless warnings: judge by output past the header.
  [ -n "$(lsof +D "$real" 2>/dev/null | tail -n +2)" ] && { echo "keep $entry: in use by a process"; return 0; }
  if [ -n "$apply" ]; then
    rm -rf -- "$entry" && echo "removed $entry"
    rmdir -- "$(dirname "$entry")" 2>/dev/null
  else
    echo "would remove $entry"
  fi
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
