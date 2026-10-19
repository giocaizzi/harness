# sweep-stale.ps1 [--branches] [--apply]   list (default) or remove stale git worktrees of the current repo
#
# --branches sweeps branches instead: remote branches with no open PR (branches of closed or
# never-opened PRs; GitHub only deletes on merge) and local branches whose upstream is gone.
# It fetches --prune first. Open PRs come from `gh`, or from SWEEP_OPEN_BRANCHES (one name per
# line) when set. --apply deletes them (`git push origin --delete`, `git branch -D`); the default
# branch, the checked-out branches of every worktree and branches that are a base of an open PR
# are never touched.
#
# A worktree is stale only when ALL hold: no file modified in the last 24 h, no process with a
# file or its cwd under it, no uncommitted changes. The main checkout and the current worktree
# are never touched. Removal is `git worktree remove` (never --force); branches stay.
# Busy check: on Windows, renaming the worktree fails while any process has a file or its cwd
# in it, so the sweep renames it and back; elsewhere it asks lsof.
$ErrorActionPreference = 'Continue' # native stderr must not throw (Windows PowerShell 5.1)
$apply = $args -contains '--apply'
$branches = $args -contains '--branches'
$unknown = @($args | Where-Object { $_ -notin '--apply', '--branches' })
if ($unknown.Count) { [Console]::Error.WriteLine('usage: sweep-stale.ps1 [--branches] [--apply]'); exit 2 }
if ($branches) {
    git fetch -q --prune origin
    if ($LASTEXITCODE) { [Console]::Error.WriteLine('sweep: fetch failed; nothing changed'); exit 1 }
    $default = (git symbolic-ref -q --short refs/remotes/origin/HEAD 2>$null) -replace '^origin/', ''
    if (-not $default) { $default = 'main' }
    if ($null -ne $env:SWEEP_OPEN_BRANCHES) { $open = @($env:SWEEP_OPEN_BRANCHES -split "`r?`n") }
    else {
        $open = @(gh pr list --state open --limit 1000 --json headRefName,baseRefName --jq '.[] | .headRefName, .baseRefName')
        if ($LASTEXITCODE) { [Console]::Error.WriteLine('sweep: gh pr list failed; nothing changed'); exit 1 }
    }
    # Branches checked out in any worktree are in use.
    $held = @(git worktree list --porcelain | Where-Object { $_ -like 'branch refs/heads/*' } | ForEach-Object { $_.Substring(18) })
    foreach ($b in @(git for-each-ref '--format=%(refname:lstrip=3)' refs/remotes/origin)) {
        if ($b -in 'HEAD', $default -or $b -in $open) { continue }
        if ($apply) {
            git push -q origin --delete $b
            if (-not $LASTEXITCODE) { "deleted origin/$b" }
        } else { "would delete origin/${b}: no open PR" }
    }
    foreach ($line in @(git for-each-ref '--format=%(refname:short) %(upstream:track)' refs/heads)) {
        if ($line -notmatch ' \[gone\]$') { continue }
        $b = $line -replace ' \[gone\]$', ''
        if ($b -in $held) { "keep ${b}: checked out in a worktree"; continue }
        if ($apply) {
            git branch -q -D $b
            if (-not $LASTEXITCODE) { "deleted $b" }
        } else { "would delete ${b}: upstream gone" }
    }
    exit 0
}
$onWindows = $IsWindows -or $PSVersionTable.PSEdition -eq 'Desktop'
if (-not $onWindows -and -not (Get-Command lsof -ErrorAction SilentlyContinue)) {
    [Console]::Error.WriteLine('sweep: lsof not found; cannot tell busy worktrees, nothing removed'); exit 1
}
function Get-FullPath([string]$Path) { [IO.Path]::GetFullPath($Path).TrimEnd('\', '/') }
$here = Get-FullPath (git rev-parse --show-toplevel)
if ($LASTEXITCODE) { exit 1 }

function Test-Busy([string]$Path) {
    if ($onWindows) {
        $probe = "$Path.sweep-probe"
        try { Rename-Item -LiteralPath $Path -NewName (Split-Path -Leaf $probe) -ErrorAction Stop } catch { return $true }
        Rename-Item -LiteralPath $probe -NewName (Split-Path -Leaf $Path)
        return $false
    }
    # lsof exits 1 for "nothing found" and also on harmless warnings: judge by output past the header.
    @(lsof +D $Path 2>$null | Select-Object -Skip 1).Count -gt 0
}

$since = (Get-Date).AddHours(-24)
$trees = @(git worktree list --porcelain | Where-Object { $_ -like 'worktree *' } | ForEach-Object { $_.Substring(9) } | Select-Object -Skip 1)
foreach ($wt in $trees) {
    if (-not (Test-Path -LiteralPath $wt)) { "keep ${wt}: missing (git worktree prune clears it)"; continue }
    if ((Get-FullPath $wt) -eq $here) { "keep ${wt}: current worktree"; continue }
    $recent = @(Get-Item -LiteralPath $wt -Force) + @(Get-ChildItem -LiteralPath $wt -Recurse -Force -ErrorAction SilentlyContinue) |
        Where-Object { $_.LastWriteTime -gt $since } | Select-Object -First 1
    if ($recent) { "keep ${wt}: modified in the last 24 h"; continue }
    if (Test-Busy $wt) { "keep ${wt}: in use by a process"; continue }
    $dirty = git -C $wt status --porcelain 2>$null
    if ($LASTEXITCODE) { "keep ${wt}: git status failed"; continue }
    if ($dirty) { "keep ${wt}: uncommitted changes"; continue }
    if ($apply) {
        git worktree remove $wt
        if (-not $LASTEXITCODE) { "removed $wt" }
    } else { "would remove $wt" }
}
if ($apply) { git worktree prune }
exit 0
