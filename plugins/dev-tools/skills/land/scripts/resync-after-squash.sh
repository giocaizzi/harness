#!/usr/bin/env bash
# resync-after-squash.sh <last-integration-sha> [<base>]   bring a branch up to date after its integration branch was squash-merged
#
# The branch still carries the integration branch's commits up to <last-integration-sha>, which the base now holds
# as one squash commit, so a plain merge conflicts on every file both touched. Instead: record origin/<base> as
# merged keeping this tree (`git merge --no-commit -s ours`), apply only what the base changed since that sha
# (`git diff <sha> origin/<base>`), and commit. Then prove it: the files the merge changed must be exactly the
# files the base changed since the sha; both lists are printed.
# <base> defaults to origin's default branch. Refuses on a dirty tree or a branch that does not contain the sha.
# Exits 0 when proven or already up to date, 1 when refused, when the patch does not apply (the merge is aborted)
# or when the proof fails (the commit is reset away), 2 on usage. An empty patch is fine: the base only gained the squash.
set -u -o pipefail
usage() { echo "usage: resync-after-squash.sh <last-integration-sha> [<base>]" >&2; exit 2; }
if [ $# -lt 1 ] || [ $# -gt 2 ]; then usage; fi
case $1 in -*) usage ;; esac
die() { echo "resync-after-squash: $*" >&2; exit 1; }
base=${2:-}
if [ -z "$base" ]; then
  if base=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null); then base=${base#origin/}; else base=main; fi
fi
case $base in -*) usage ;; esac
git check-ref-format --branch "$base" >/dev/null 2>&1 || usage
cd "$(git rev-parse --show-toplevel)" || die "cannot reach the top of the worktree"
sha=$(git rev-parse --verify --quiet "$1^{commit}") || die "$1 is not a commit"
[ -z "$(git status --porcelain --untracked-files=no)" ] || die "the working tree has uncommitted changes"
git merge-base --is-ancestor "$sha" HEAD || die "the current branch does not contain $sha"
git fetch --quiet origin -- "$base" || die "git fetch origin $base failed"
upstream=$(git rev-parse --verify --quiet "refs/remotes/origin/$base^{commit}") || die "origin/$base not found"
if git merge-base --is-ancestor "$upstream" HEAD; then echo "already up to date with origin/$base"; exit 0; fi
old=$(git rev-parse HEAD)
git merge --quiet --no-commit -s ours "$upstream" >/dev/null || die "git merge -s ours origin/$base failed"
# Fixed diff options, so repo or user config (diff.context, diff.relative, submodule settings) cannot change the patch
# or the file lists (the script runs from the top level: git apply ignores paths outside the current directory).
diff=(git diff --no-ext-diff --no-color --no-textconv -U3 --no-relative --ignore-submodules=none --submodule=short --src-prefix=a/ --dst-prefix=b/)
if ! "${diff[@]}" --binary "$sha" "$upstream" -- | git apply --index --allow-empty; then
  git merge --abort
  die "the base's changes since $sha do not apply on this branch: merge by hand"
fi
git commit --quiet -m "Merge origin/$base after the integration branch's squash merge" \
  -m "Applied only git diff $sha origin/$base on top of $old." || die "git commit failed"
merged=$("${diff[@]}" --name-only "$old" HEAD --) || die "git diff failed"
expected=$("${diff[@]}" --name-only "$sha" "$upstream" --) || die "git diff failed"
echo "files changed by the merge ($old..HEAD):"; printf '%s\n' "$merged" | sed '/^$/d; s/^/  /'
echo "files the base changed since the sha ($sha..origin/$base):"; printf '%s\n' "$expected" | sed '/^$/d; s/^/  /'
if [ "$merged" != "$expected" ]; then git reset --quiet --hard "$old"; die "the lists differ: the merge commit was reset away, merge by hand"; fi
echo "proven: the merge brings only the base's changes"
