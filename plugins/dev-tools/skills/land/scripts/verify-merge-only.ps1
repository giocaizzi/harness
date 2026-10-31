# verify-merge-only.ps1 <approved-sha> <new-sha> [<base>]   prove the commits pushed after a review verdict are only a merge of the base
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
# Every git call but the fetch runs with the global and system config ignored and the merge settings pinned.
# Exits 0 when proven or when nothing was pushed since the approval, 1 when refused or not proven, 2 on usage.
# Never modifies the repo besides the fetch. The last lines printed are the landing note to paste into the PR comment.
$ErrorActionPreference = 'Stop'
$argv = @($args)
$usageText = 'usage: verify-merge-only.ps1 <approved-sha> <new-sha> [<default-branch>]'
$shaPattern = '^([0-9a-f]{40}|[0-9a-f]{64})$'
if ($argv.Count -lt 2 -or $argv.Count -gt 3 -or "$($argv[0])" -cnotmatch $shaPattern -or "$($argv[1])" -cnotmatch $shaPattern) {
    [Console]::Error.WriteLine($usageText); exit 2
}
$approved = "$($argv[0])"
$new = "$($argv[1])"
function Exit-Verify([string]$Why) { [Console]::Error.WriteLine("verify-merge-only: $Why"); exit 1 }
$default = git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>$null
if ($LASTEXITCODE -ne 0 -or -not $default) { Exit-Verify 'origin/HEAD is not set: run git remote set-head origin --auto' }
$default = "$default" -replace '^origin/', ''
$null = git check-ref-format --branch $default 2>$null
if ($LASTEXITCODE -ne 0) { Exit-Verify "origin/HEAD names an invalid branch: $default" }
$base = if ($argv.Count -eq 3) { "$($argv[2])" } else { $default }
if ($base -cne $default) { Exit-Verify "<base> must be origin's default branch ($default), not $base" }
$null = git fetch --quiet origin -- $base
if ($LASTEXITCODE -ne 0) { Exit-Verify "git fetch origin $base failed" }
# From here on git ignores the global and system config, and the merge settings are pinned.
$env:GIT_CONFIG_GLOBAL = 'NUL'
$env:GIT_CONFIG_NOSYSTEM = '1'
$pin = @('-c', 'core.attributesFile=NUL', '-c', 'merge.renames=true', '-c', 'merge.directoryRenames=conflict', '-c', 'merge.renormalize=false')
foreach ($sha in @($approved, $new)) {
    $type = git @pin cat-file -t $sha 2>$null
    if ($LASTEXITCODE -ne 0 -or "$type" -ne 'commit') { Exit-Verify "$sha is not a commit here: fetch the PR head first" }
}
$upstream = git @pin rev-parse --verify --quiet "refs/remotes/origin/$base^{commit}"
if ($LASTEXITCODE -ne 0 -or -not $upstream) { Exit-Verify "origin/$base not found" }
if ($new -eq $approved) {
    "no commits since approval: $new"
    "Landing note: approved head $approved; merging head $new."
    'No commits were pushed after the approval. Checked by verify-merge-only.'
    exit 0
}
$line = git @pin rev-list --parents -n1 $new
if ($LASTEXITCODE -ne 0) { Exit-Verify 'git rev-list failed' }
$parents = @("$line".Trim() -split ' ')
if ($parents.Count -ne 3 -or $parents[1] -ne $approved) {
    Exit-Verify "$new is not a two-parent merge whose first parent is the approved head: review the delta"
}
$merged = $parents[2]
$null = git @pin merge-base --is-ancestor $merged $upstream
if ($LASTEXITCODE -ne 0) { Exit-Verify "the merged commit $merged is not on origin/$base" }
$tree = git @pin rev-parse --verify --quiet "$new^{tree}"
if ($LASTEXITCODE -ne 0 -or -not $tree) { Exit-Verify "no tree for $new" }
$redo = @(git @pin merge-tree --write-tree --no-messages $approved $merged 2>$null)
$status = $LASTEXITCODE
if ($status -ne 0) {
    Exit-Verify "git cannot redo the merge of $merged into $approved without a conflict (merge-tree exit $status): the resolution is new code, review the delta"
}
if ($redo.Count -lt 1 -or "$($redo[0])" -cne "$tree") {
    [Console]::Error.WriteLine("tree of ${new}: $tree")
    [Console]::Error.WriteLine("tree git merge-tree gives: $(if ($redo.Count) { $redo[0] })")
    Exit-Verify 'the merge commit differs from the merge git makes: review the delta as a new round'
}
"Landing note: approved head $approved; merging head $new."
"$new is a pure merge of origin/$base at ${merged}: two parents, the first the approved head, $merged on origin/$base, and git merge-tree --write-tree $approved $merged gives exactly its tree $tree. Checked by verify-merge-only."
