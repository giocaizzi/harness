# resync-after-squash.ps1 <last-integration-sha> [<base>]   bring a branch up to date after its integration branch was squash-merged
#
# The branch still carries the integration branch's commits up to <last-integration-sha>, which the base now holds
# as one squash commit, so a plain merge conflicts on every file both touched. Instead: record origin/<base> as
# merged keeping this tree (`git merge --no-commit -s ours`), apply only what the base changed since that sha
# (`git diff <sha> origin/<base>`), and commit. Then prove it: the files the merge changed must be exactly the
# files the base changed since the sha; both lists are printed.
# <base> defaults to origin's default branch. Refuses on a dirty tree or a branch that does not contain the sha.
# Exits 0 when proven or already up to date, 1 when refused, the patch does not apply (the merge is aborted)
# or the proof fails (the commit stays, for review), 2 on usage.
$ErrorActionPreference = 'Stop'
$argv = @($args)
if ($argv.Count -lt 1 -or $argv.Count -gt 2 -or "$($argv[0])".StartsWith('-')) {
    [Console]::Error.WriteLine('usage: resync-after-squash.ps1 <last-integration-sha> [<base>]'); exit 2
}
function Stop-Resync([string]$Why) { [Console]::Error.WriteLine("resync-after-squash: $Why"); exit 1 }
$base = if ($argv.Count -eq 2) { "$($argv[1])" } else { '' }
if (-not $base) {
    $head = git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>$null
    $base = if ($LASTEXITCODE -eq 0 -and $head) { "$head" -replace '^origin/', '' } else { 'main' }
}
$sha = git rev-parse --verify --quiet "$($argv[0])^{commit}"
if ($LASTEXITCODE -ne 0 -or -not $sha) { Stop-Resync "$($argv[0]) is not a commit" }
if (git status --porcelain --untracked-files=no) { Stop-Resync 'the working tree has uncommitted changes' }
$null = git merge-base --is-ancestor $sha HEAD
if ($LASTEXITCODE -ne 0) { Stop-Resync "the current branch does not contain $sha" }
$null = git fetch --quiet origin $base
if ($LASTEXITCODE -ne 0) { Stop-Resync "git fetch origin $base failed" }
$upstream = git rev-parse --verify "origin/$base"
if ($LASTEXITCODE -ne 0) { Stop-Resync "origin/$base not found" }
$null = git merge-base --is-ancestor $upstream HEAD
if ($LASTEXITCODE -eq 0) { "already up to date with origin/$base"; exit 0 }
$old = git rev-parse HEAD
$null = git merge --quiet --no-commit -s ours $upstream
if ($LASTEXITCODE -ne 0) { Stop-Resync "git merge -s ours origin/$base failed" }
# The patch goes through a file: a PowerShell pipe between native commands re-encodes the bytes.
$patch = [IO.Path]::GetTempFileName()
try {
    $null = git diff --binary --output=$patch $sha $upstream
    $null = git apply --index --allow-empty $patch
    if ($LASTEXITCODE -ne 0) {
        $null = git merge --abort
        Stop-Resync "the base's changes since $sha do not apply on this branch: merge by hand"
    }
} finally { Remove-Item -Force -ErrorAction SilentlyContinue $patch }
$null = git commit --quiet -m "Merge origin/$base after the integration branch's squash merge" -m "Applied only git diff $sha origin/$base on top of $old."
if ($LASTEXITCODE -ne 0) { Stop-Resync 'git commit failed' }
$merged = @(git diff --name-only $old HEAD)
$expected = @(git diff --name-only $sha $upstream)
"files changed by the merge ($old..HEAD):"; $merged | ForEach-Object { "  $_" }
"files the base changed since the sha ($sha..origin/$base):"; $expected | ForEach-Object { "  $_" }
if (($merged -join "`n") -ne ($expected -join "`n")) { Stop-Resync 'the lists differ: review HEAD before pushing' }
'proven: the merge brings only the base''s changes'
