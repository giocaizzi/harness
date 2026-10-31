#!/usr/bin/env bash
# verify-merge-only.sh <approved-head> <new-head> [<base>]   prove the commits pushed after a review verdict are only a merge of the base
#
# <approved-head> is the PR head the review approved, <new-head> the head now (fetch it first). When <new-head> is
# <approved-head>, nothing was pushed. Otherwise <new-head> must be a merge commit whose first parent is the approved
# head and whose second parent M is on origin/<base> (so no unreviewed branch came in), and the merge must leave the
# PR's own change alone: `git diff M <new-head>` has the same patch id as `git diff O <approved-head>`, O being the
# merge base of the approved head and M. `git patch-id --verbatim` keeps whitespace, so a whitespace-only edit slipped
# into the merge fails, and `--binary` keeps a changed binary file from hiding behind "Binary files differ".
# Several base merges in a row are proven one at a time, each merge against the one before it.
# <base> defaults to origin's default branch. Never modifies the repo besides the fetch.
# Exits 0 when proven or when nothing was pushed since the approval, 1 when refused or not proven, 2 on usage.
# The last lines printed are the landing note to paste into the PR comment.
set -u -o pipefail
usage() { echo "usage: verify-merge-only.sh <approved-head> <new-head> [<base>]" >&2; exit 2; }
if [ $# -lt 2 ] || [ $# -gt 3 ]; then usage; fi
case $1 in -*) usage ;; esac
case $2 in -*) usage ;; esac
die() { echo "verify-merge-only: $*" >&2; exit 1; }
base=${3:-}
if [ -z "$base" ]; then
  if base=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null); then base=${base#origin/}; else base=main; fi
fi
case $base in -*) usage ;; esac
git check-ref-format --branch "$base" >/dev/null 2>&1 || usage
approved=$(git rev-parse --verify --quiet "$1^{commit}") || die "$1 is not a commit: fetch the PR head first"
new=$(git rev-parse --verify --quiet "$2^{commit}") || die "$2 is not a commit: fetch the PR head first"
git fetch --quiet origin -- "$base" || die "git fetch origin $base failed"
upstream=$(git rev-parse --verify --quiet "refs/remotes/origin/$base^{commit}") || die "origin/$base not found"
if [ "$new" = "$approved" ]; then
  echo "no commits since approval: $new"
  echo "Landing note: approved head $approved; merging head $new."
  echo "No commits were pushed after the approval. Checked by verify-merge-only."
  exit 0
fi
read -r -a parents < <(git rev-list --parents -n1 "$new") || die "git rev-list failed"
if [ "${#parents[@]}" -ne 3 ] || [ "${parents[1]}" != "$approved" ]; then
  die "$new is not a merge whose first parent is the approved head: review the delta"
fi
merged=${parents[2]}
git merge-base --is-ancestor "$merged" "$upstream" || die "the merged commit $merged is not on origin/$base"
old=$(git merge-base "$approved" "$merged") || die "no merge base of $approved and $merged"
patch_id() {
  git diff --no-ext-diff --no-color --no-textconv --no-renames --binary --src-prefix=a/ --dst-prefix=b/ "$1" "$2" -- | git patch-id --verbatim | cut -d' ' -f1
}
want=$(patch_id "$old" "$approved") || die "git diff failed"
got=$(patch_id "$merged" "$new") || die "git diff failed"
if [ "$want" != "$got" ]; then
  echo "patch id of git diff $old $approved: ${want:-<empty>}" >&2
  echo "patch id of git diff $merged $new: ${got:-<empty>}" >&2
  die "the merge changed the PR's own diff: review the delta as a new round"
fi
echo "Landing note: approved head $approved; merging head $new."
echo "$new is a pure merge of origin/$base at $merged: its first parent is the approved head, $merged is on origin/$base, and git diff $merged $new has the same patch-id (git patch-id --verbatim, ${want:-empty diff}) as git diff $old $approved. Checked by verify-merge-only."
