# verify-merge-only.ps1 <approved-head> <new-head> [<base>]   prove the commits pushed after a review verdict are only a merge of the base
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
$ErrorActionPreference = 'Stop'
$argv = @($args)
$usageText = 'usage: verify-merge-only.ps1 <approved-head> <new-head> [<base>]'
if ($argv.Count -lt 2 -or $argv.Count -gt 3 -or "$($argv[0])".StartsWith('-') -or "$($argv[1])".StartsWith('-')) {
    [Console]::Error.WriteLine($usageText); exit 2
}
function Exit-Verify([string]$Why) { [Console]::Error.WriteLine("verify-merge-only: $Why"); exit 1 }
$base = if ($argv.Count -eq 3) { "$($argv[2])" } else { '' }
if (-not $base) {
    $head = git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>$null
    $base = if ($LASTEXITCODE -eq 0 -and $head) { "$head" -replace '^origin/', '' } else { 'main' }
}
$null = git check-ref-format --branch $base 2>$null
if ($base.StartsWith('-') -or $LASTEXITCODE -ne 0) { [Console]::Error.WriteLine($usageText); exit 2 }
$approved = git rev-parse --verify --quiet "$($argv[0])^{commit}"
if ($LASTEXITCODE -ne 0 -or -not $approved) { Exit-Verify "$($argv[0]) is not a commit: fetch the PR head first" }
$new = git rev-parse --verify --quiet "$($argv[1])^{commit}"
if ($LASTEXITCODE -ne 0 -or -not $new) { Exit-Verify "$($argv[1]) is not a commit: fetch the PR head first" }
$null = git fetch --quiet origin -- $base
if ($LASTEXITCODE -ne 0) { Exit-Verify "git fetch origin $base failed" }
$upstream = git rev-parse --verify --quiet "refs/remotes/origin/$base^{commit}"
if ($LASTEXITCODE -ne 0 -or -not $upstream) { Exit-Verify "origin/$base not found" }
if ($new -eq $approved) {
    "no commits since approval: $new"
    "Landing note: approved head $approved; merging head $new."
    'No commits were pushed after the approval. Checked by verify-merge-only.'
    exit 0
}
$parents = @(("$(git rev-list --parents -n1 $new)").Trim() -split ' ')
if ($LASTEXITCODE -ne 0) { Exit-Verify 'git rev-list failed' }
if ($parents.Count -ne 3 -or $parents[1] -ne $approved) {
    Exit-Verify "$new is not a merge whose first parent is the approved head: review the delta"
}
$merged = $parents[2]
$null = git merge-base --is-ancestor $merged $upstream
if ($LASTEXITCODE -ne 0) { Exit-Verify "the merged commit $merged is not on origin/$base" }
$old = git merge-base $approved $merged
if ($LASTEXITCODE -ne 0 -or -not $old) { Exit-Verify "no merge base of $approved and $merged" }
$diff = @('diff', '--no-ext-diff', '--no-color', '--no-textconv', '--no-renames', '--binary', '--src-prefix=a/', '--dst-prefix=b/')
# The diff goes through a file and cmd's redirect: a PowerShell pipe between native commands re-encodes the bytes.
function Get-PatchId([string]$From, [string]$To) {
    $file = [IO.Path]::GetTempFileName()
    try {
        $null = git @diff "--output=$file" $From $To --
        if ($LASTEXITCODE -ne 0) { Exit-Verify 'git diff failed' }
        $line = cmd /c "git patch-id --verbatim < `"$file`""
        if ($LASTEXITCODE -ne 0) { Exit-Verify 'git patch-id failed' }
        return ("$line" -split ' ')[0]
    } finally { Remove-Item -Force -ErrorAction SilentlyContinue $file }
}
$want = Get-PatchId $old $approved
$got = Get-PatchId $merged $new
if ($want -cne $got) {
    [Console]::Error.WriteLine("patch id of git diff $old ${approved}: $(if ($want) { $want } else { '<empty>' })")
    [Console]::Error.WriteLine("patch id of git diff $merged ${new}: $(if ($got) { $got } else { '<empty>' })")
    Exit-Verify "the merge changed the PR's own diff: review the delta as a new round"
}
$shown = if ($want) { $want } else { 'empty diff' }
"Landing note: approved head $approved; merging head $new."
"$new is a pure merge of origin/$base at ${merged}: its first parent is the approved head, $merged is on origin/$base, and git diff $merged $new has the same patch-id (git patch-id --verbatim, $shown) as git diff $old $approved. Checked by verify-merge-only."
