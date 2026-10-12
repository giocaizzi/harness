# sweep-stale.ps1 [--apply]   list (default) or remove stale git worktrees of the current repo
#
# A worktree is stale only when ALL hold: no file modified in the last 24 h, no process with a
# file or its cwd under it, no uncommitted changes. The main checkout and the current worktree
# are never touched. Removal is `git worktree remove` (never --force); branches stay.
# Busy check: on Windows, renaming the worktree fails while any process has a file or its cwd
# in it, so the sweep renames it and back; elsewhere it asks lsof.
$ErrorActionPreference = 'Continue' # native stderr must not throw (Windows PowerShell 5.1)
$apply = $args.Count -gt 0 -and $args[0] -eq '--apply'
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
