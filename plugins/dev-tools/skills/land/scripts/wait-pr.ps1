# wait-pr.ps1 <pr> [--interval <s>] [--timeout <s>]   wait on a PR until it ends, whichever way it ends
#
# Polls `gh pr view` and `gh pr checks --required` once per interval ($env:GH_REPO selects another repo)
# and exits on the first terminal outcome, printing one line on what happened:
#   0    merged
#   1    closed without merging
#   3    a required check failed or was cancelled (each one's name and link follow)
#   4    mergeStateStatus BEHIND (update the branch) or DIRTY (resolve the conflict)
#   5    `gh pr view` failed 3 polls in a row (bad PR, auth, network; its error follows)
#   124  timeout, with the last state and the required checks still pending
#   2    usage
# --interval and --timeout default to WAIT_PR_INTERVAL (45) and WAIT_PR_TIMEOUT (5400) seconds.
$ErrorActionPreference = 'Stop'
function Exit-Usage { [Console]::Error.WriteLine('usage: wait-pr.ps1 <pr> [--interval <s>] [--timeout <s>]'); exit 2 }
$pr = ''
$interval = if ($env:WAIT_PR_INTERVAL) { $env:WAIT_PR_INTERVAL } else { '45' }
$timeout = if ($env:WAIT_PR_TIMEOUT) { $env:WAIT_PR_TIMEOUT } else { '5400' }
$argv = @($args)
for ($i = 0; $i -lt $argv.Count; $i++) {
    $a = "$($argv[$i])"
    if ($a -eq '--interval' -or $a -eq '--timeout') {
        if ($i + 1 -ge $argv.Count) { Exit-Usage }
        $i++
        if ($a -eq '--interval') { $interval = $argv[$i] } else { $timeout = $argv[$i] }
    } elseif ($a.StartsWith('-') -or $pr) { Exit-Usage }
    else { $pr = $a }
}
if (-not $pr -or "$interval" -notmatch '^\d+$' -or "$timeout" -notmatch '^\d+$') { Exit-Usage }
$interval = [int]$interval; $timeout = [int]$timeout

$deadline = [DateTime]::UtcNow.AddSeconds($timeout)
$fails = 0; $state = ''; $merge = ''; $pending = ''
$err = [IO.Path]::GetTempFileName()
try {
    while ($true) {
        $ErrorActionPreference = 'Continue'
        $view = gh pr view $pr --json 'state,mergeStateStatus' 2>$err
        $viewExit = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
        if ($viewExit -eq 0) {
            $fails = 0
            $v = ConvertFrom-Json -InputObject ($view -join "`n")
            $state = $v.state; $merge = $v.mergeStateStatus
            if ($state -eq 'MERGED') { "PR $pr merged"; exit 0 }
            if ($state -eq 'CLOSED') { "PR $pr closed without merging"; exit 1 }
            # Exits non-zero while checks are pending or failed, and prints nothing when the PR has none: read the output only.
            $ErrorActionPreference = 'Continue'
            $out = gh pr checks $pr --required --json 'name,bucket,link' 2>$null
            $ErrorActionPreference = 'Stop'
            $checks = @()
            try { $checks = @(ConvertFrom-Json -InputObject ($out -join "`n")) | Where-Object { $_ } } catch { $checks = @() }
            $failed = @($checks | Where-Object { $_.bucket -in 'fail', 'cancel' })
            if ($failed.Count -gt 0) {
                "PR ${pr}: required check failed"
                foreach ($c in $failed) { "  $($c.name) $($c.link)" }
                exit 3
            }
            $pending = (@($checks | Where-Object { $_.bucket -eq 'pending' }) | ForEach-Object { $_.name }) -join ','
            if ($merge -eq 'BEHIND') { "PR $pr is behind its base: update the branch"; exit 4 }
            if ($merge -eq 'DIRTY') { "PR $pr has a merge conflict: resolve it"; exit 4 }
        } else {
            $fails++
            if ($fails -ge 3) {
                [Console]::Error.WriteLine("wait-pr: gh pr view $pr failed $fails times in a row:")
                [Console]::Error.WriteLine((Get-Content -Raw $err))
                exit 5
            }
        }
        $left = [int][Math]::Ceiling(($deadline - [DateTime]::UtcNow).TotalSeconds)
        if ($left -le 0) {
            $s = if ($state) { $state } else { 'unknown' }
            $m = if ($merge) { $merge } else { 'unknown' }
            $p = if ($pending) { $pending } else { 'none' }
            "PR ${pr}: timed out after ${timeout}s, state $s, mergeStateStatus $m, pending required checks: $p"
            exit 124
        }
        Start-Sleep -Seconds ([Math]::Min($interval, $left))
    }
} finally {
    Remove-Item -Force -ErrorAction SilentlyContinue $err
}
