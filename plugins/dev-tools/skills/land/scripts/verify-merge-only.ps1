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
# Every git call but the fetch runs with the global and system config ignored, hooks off and the merge settings pinned;
# attributes come from the approved tree (`--attr-source`), not the checkout. Settings the script cannot override make it
# refuse: a non-empty .git/info/attributes, a merge driver in the repo config (`merge.<name>.driver`), a shallow clone.
# Run it from a plain clone. Needs git 2.40 or newer (merge-tree --write-tree is 2.38, --attr-source 2.40).
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
$null = git -c core.hooksPath=NUL fetch --quiet origin -- $base
if ($LASTEXITCODE -ne 0) { Exit-Verify "git fetch origin $base failed" }
# Every later git call ignores the global and system config, runs no hooks and pins the merge settings. The two
# variables are set for that call only and restored after it, so a caller's session keeps its own config.
$pin = @('-c', 'core.hooksPath=NUL', '-c', 'core.attributesFile=NUL', '-c', 'merge.renames=true', '-c', 'merge.directoryRenames=conflict', '-c', 'merge.renormalize=false')
function Invoke-IsolatedGit([string[]]$GitArgs) {
    $saved = @{}
    foreach ($name in 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM') { $saved[$name] = [Environment]::GetEnvironmentVariable($name) }
    try {
        [Environment]::SetEnvironmentVariable('GIT_CONFIG_GLOBAL', 'NUL')
        [Environment]::SetEnvironmentVariable('GIT_CONFIG_NOSYSTEM', '1')
        & git @pin @GitArgs
    } finally {
        foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name]) }
    }
}
foreach ($sha in @($approved, $new)) {
    $type = Invoke-IsolatedGit @('cat-file', '-t', $sha) 2>$null
    if ($LASTEXITCODE -ne 0 -or "$type" -ne 'commit') { Exit-Verify "$sha is not a commit here: fetch the PR head first" }
}
$shallow = Invoke-IsolatedGit @('rev-parse', '--is-shallow-repository')
if ($LASTEXITCODE -ne 0 -or "$shallow" -ne 'false') { Exit-Verify 'shallow clone: deepen it (git fetch --unshallow origin)' }
$info = Invoke-IsolatedGit @('rev-parse', '--git-path', 'info/attributes')
if ($LASTEXITCODE -ne 0 -or -not $info) { Exit-Verify 'git rev-parse failed' }
if ((Test-Path -LiteralPath "$info" -PathType Leaf) -and @(Get-Content -LiteralPath "$info" | Where-Object { $_ -notmatch '^\s*(#.*)?$' }).Count) {
    Exit-Verify "$info sets attributes the merge would use: verify from a clone without it"
}
$null = Invoke-IsolatedGit @('config', '--get-regexp', '^merge\..*\.driver$')
if ($LASTEXITCODE -eq 0) { Exit-Verify "a merge driver is configured in this repo (git config --get-regexp 'merge[.].*[.]driver'): verify from a clone without it" }
$upstream = Invoke-IsolatedGit @('rev-parse', '--verify', '--quiet', "refs/remotes/origin/$base^{commit}")
if ($LASTEXITCODE -ne 0 -or -not $upstream) { Exit-Verify "origin/$base not found" }
if ($new -eq $approved) {
    "no commits since approval: $new"
    "Landing note: approved head $approved; merging head $new."
    'No commits were pushed after the approval. Checked by verify-merge-only.'
    exit 0
}
$line = Invoke-IsolatedGit @('rev-list', '--parents', '-n1', $new)
if ($LASTEXITCODE -ne 0) { Exit-Verify 'git rev-list failed' }
$parents = @("$line".Trim() -split ' ')
if ($parents.Count -ne 3 -or $parents[1] -ne $approved) {
    Exit-Verify "$new is not a two-parent merge whose first parent is the approved head: review the delta"
}
$merged = $parents[2]
$null = Invoke-IsolatedGit @('merge-base', '--is-ancestor', $merged, $upstream)
if ($LASTEXITCODE -ne 0) { Exit-Verify "the merged commit $merged is not on origin/$base" }
$tree = Invoke-IsolatedGit @('rev-parse', '--verify', '--quiet', "$new^{tree}")
if ($LASTEXITCODE -ne 0 -or -not $tree) { Exit-Verify "no tree for $new" }
$redo = @(Invoke-IsolatedGit @("--attr-source=$approved", 'merge-tree', '--write-tree', '--no-messages', $approved, $merged) 2>$null)
$status = $LASTEXITCODE
if ($status -eq 129) { Exit-Verify 'needs git 2.40 or newer (git --attr-source, git merge-tree --write-tree)' }
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
