#!/usr/bin/env bash
# verify-merge-only.sh <approved-sha> <new-sha> [<base>]   prove the commits pushed after a review verdict are only a merge of the base
#
# <approved-sha> is the PR head the review approved, <new-sha> the head now: full commit SHAs (40 or 64 hex), never a
# ref name, both fetched first. <base> must be origin's default branch, read from origin/HEAD (`git remote set-head
# origin --auto` sets it); a PR on another base is not proven here. When the two SHAs are equal, nothing was pushed.
# Otherwise <new-sha> must be a merge commit with exactly two parents, the first being <approved-sha> and the second,
# M, on origin/<base> (so no unreviewed branch came in), and git must redo that merge on its own:
# `git merge-tree --write-tree <approved-sha> M` exits 0 (no conflict) and prints exactly the tree of <new-sha>.
# A conflicted merge, or any other tree, is refused: its resolution is new code and goes to a new review round.
# Why not `git patch-id`: it ignores the @@ lines, so a merge that moves the PR's hunk to an identical block elsewhere
# in the file kept the same id, and diff config (diff.context, diff.relative, submodule settings) could hide changes.
# Every git call but the fetch runs with the global and system config ignored, hooks off and the merge settings pinned;
# attributes come from the approved tree (`--attr-source`), not the checkout. Settings the script cannot override make it
# refuse: a non-empty .git/info/attributes, a merge driver in the repo config (`merge.<name>.driver`), a shallow clone.
# Run it from a plain clone. Needs git 2.40 or newer (merge-tree --write-tree is 2.38, --attr-source 2.40).
# Exits 0 when proven or when nothing was pushed since the approval, 1 when refused or not proven, 2 on usage.
# Never modifies the repo besides the fetch. The last lines printed are the landing note to paste into the PR comment.
set -u -o pipefail
usage() { echo "usage: verify-merge-only.sh <approved-sha> <new-sha> [<default-branch>]" >&2; exit 2; }
if [ $# -lt 2 ] || [ $# -gt 3 ]; then usage; fi
sha_re='^([0-9a-f]{40}|[0-9a-f]{64})$'
[[ $1 =~ $sha_re ]] || usage
[[ $2 =~ $sha_re ]] || usage
approved=$1 new=$2
die() { echo "verify-merge-only: $*" >&2; exit 1; }
default=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null) \
  || die "origin/HEAD is not set: run git remote set-head origin --auto"
default=${default#origin/}
git check-ref-format --branch "$default" >/dev/null 2>&1 || die "origin/HEAD names an invalid branch: $default"
base=${3:-$default}
[ "$base" = "$default" ] || die "<base> must be origin's default branch ($default), not $base"
null=/dev/null
git -c core.hooksPath=$null fetch --quiet origin -- "$base" || die "git fetch origin $base failed"
g() {
  GIT_CONFIG_GLOBAL=$null GIT_CONFIG_NOSYSTEM=1 git -c core.hooksPath=$null -c core.attributesFile=$null \
    -c merge.renames=true -c merge.directoryRenames=conflict -c merge.renormalize=false "$@"
}
[ "$(g cat-file -t "$approved" 2>/dev/null)" = commit ] || die "$approved is not a commit here: fetch the PR head first"
[ "$(g cat-file -t "$new" 2>/dev/null)" = commit ] || die "$new is not a commit here: fetch the PR head first"
[ "$(g rev-parse --is-shallow-repository)" = false ] || die "shallow clone: deepen it (git fetch --unshallow origin)"
info=$(g rev-parse --git-path info/attributes) || die "git rev-parse failed"
if [ -f "$info" ] && grep -Eqv '^[[:space:]]*(#.*)?$' "$info"; then
  die "$info sets attributes the merge would use: verify from a clone without it"
fi
if g config --get-regexp '^merge\..*\.driver$' >/dev/null; then
  die "a merge driver is configured in this repo (git config --get-regexp 'merge[.].*[.]driver'): verify from a clone without it"
fi
upstream=$(g rev-parse --verify --quiet "refs/remotes/origin/$base^{commit}") || die "origin/$base not found"
if [ "$new" = "$approved" ]; then
  echo "no commits since approval: $new"
  echo "Landing note: approved head $approved; merging head $new."
  echo "No commits were pushed after the approval. Checked by verify-merge-only."
  exit 0
fi
read -r -a parents < <(g rev-list --parents -n1 "$new") || die "git rev-list failed"
if [ "${#parents[@]}" -ne 3 ] || [ "${parents[1]}" != "$approved" ]; then
  die "$new is not a two-parent merge whose first parent is the approved head: review the delta"
fi
merged=${parents[2]}
g merge-base --is-ancestor "$merged" "$upstream" || die "the merged commit $merged is not on origin/$base"
tree=$(g rev-parse --verify --quiet "$new^{tree}") || die "no tree for $new"
redo=$(g --attr-source="$approved" merge-tree --write-tree --no-messages "$approved" "$merged" 2>/dev/null)
status=$?
[ "$status" -ne 129 ] || die "needs git 2.40 or newer (git --attr-source, git merge-tree --write-tree)"
[ "$status" -eq 0 ] || die "git cannot redo the merge of $merged into $approved without a conflict (merge-tree exit $status): the resolution is new code, review the delta"
redo=${redo%%$'\n'*}
if [ "$redo" != "$tree" ]; then
  echo "tree of $new: $tree" >&2
  echo "tree git merge-tree gives: $redo" >&2
  die "the merge commit differs from the merge git makes: review the delta as a new round"
fi
echo "Landing note: approved head $approved; merging head $new."
echo "$new is a pure merge of origin/$base at $merged: two parents, the first the approved head, $merged on origin/$base, and git merge-tree --write-tree $approved $merged gives exactly its tree $tree. Checked by verify-merge-only."
