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
# --interval (1-3600) and --timeout (1-86400) default to WAIT_PR_INTERVAL (45) and WAIT_PR_TIMEOUT (5400) seconds.
# The deadline is the script's own, gh calls included (one that does not return by then is killed):
# exiting is what wakes a session that started it in the background.
$ErrorActionPreference = 'Stop'
function Exit-Usage { [Console]::Error.WriteLine('usage: wait-pr.ps1 <pr> [--interval <1-3600 s>] [--timeout <1-86400 s>]'); exit 2 }
# A plain decimal integer from 1 to $Max: no sign, no leading zero, nothing too large for [int].
function Get-Duration([string]$Value, [int]$Max) {
    if ($Value -cnotmatch '^[1-9][0-9]{0,4}$' -or [int]$Value -gt $Max) { Exit-Usage }
    [int]$Value
}
$pr = ''
$interval = if ($null -ne $env:WAIT_PR_INTERVAL -and $env:WAIT_PR_INTERVAL -ne '') { $env:WAIT_PR_INTERVAL } else { '45' }
$timeout = if ($null -ne $env:WAIT_PR_TIMEOUT -and $env:WAIT_PR_TIMEOUT -ne '') { $env:WAIT_PR_TIMEOUT } else { '5400' }
$argv = @($args)
for ($i = 0; $i -lt $argv.Count; $i++) {
    $a = "$($argv[$i])"
    if ($a -eq '--interval' -or $a -eq '--timeout') {
        if ($i + 1 -ge $argv.Count) { Exit-Usage }
        $i++
        if ($a -eq '--interval') { $interval = "$($argv[$i])" } else { $timeout = "$($argv[$i])" }
    } elseif ($a.StartsWith('-') -or $pr) { Exit-Usage }
    else { $pr = $a }
}
if (-not $pr) { Exit-Usage }
$interval = Get-Duration $interval 3600
$timeout = Get-Duration $timeout 86400
$gh = (Get-Command gh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $gh) { [Console]::Error.WriteLine('wait-pr: gh not found on PATH'); exit 5 }

$deadline = [DateTime]::UtcNow.AddSeconds($timeout)
$fails = 0; $state = ''; $merge = ''; $pending = ''
$tmp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
$outFile = Join-Path $tmp 'out'; $errFile = Join-Path $tmp 'err'
function Exit-Timeout([string]$Hung) {
    $s = if ($state) { $state } else { 'unknown' }
    $m = if ($merge) { $merge } else { 'unknown' }
    $p = if ($pending) { $pending } else { 'none' }
    $h = if ($Hung) { " ($Hung did not return)" } else { '' }
    "PR ${pr}: timed out after ${timeout}s, state $s, mergeStateStatus $m, pending required checks: $p$h"
    exit 124
}
# gh's stdout in $outFile, stderr in $errFile, its exit code returned; killed at the deadline.
function Invoke-Gh([string]$Label, [string[]]$GhArgs) {
    $ms = [int][Math]::Max(0, [Math]::Ceiling(($deadline - [DateTime]::UtcNow).TotalMilliseconds))
    $proc = Start-Process -FilePath $gh -ArgumentList $GhArgs -NoNewWindow -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    $null = $proc.Handle
    if (-not $proc.WaitForExit($ms)) {
        try { $proc.Kill($true) } catch { try { $proc.Kill() } catch { $null = $_ } }
        Exit-Timeout $Label
    }
    $proc.WaitForExit()
    $proc.ExitCode
}
try {
    while ($true) {
        $viewExit = Invoke-Gh 'gh pr view' @('pr', 'view', $pr, '--json', 'state,mergeStateStatus')
        if ($viewExit -eq 0) {
            $fails = 0
            $v = ConvertFrom-Json -InputObject (Get-Content -Raw $outFile)
            $state = $v.state; $merge = $v.mergeStateStatus
            if ($state -eq 'MERGED') { "PR $pr merged"; exit 0 }
            if ($state -eq 'CLOSED') { "PR $pr closed without merging"; exit 1 }
            # Exits non-zero while checks are pending or failed, and prints nothing when the PR has none: read the output only.
            $null = Invoke-Gh 'gh pr checks' @('pr', 'checks', $pr, '--required', '--json', 'name,bucket,link')
            $checks = @()
            try { $checks = @(ConvertFrom-Json -InputObject (Get-Content -Raw $outFile)) | Where-Object { $_ } } catch { $checks = @() }
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
                [Console]::Error.WriteLine((Get-Content -Raw $errFile))
                exit 5
            }
        }
        $left = [int][Math]::Ceiling(($deadline - [DateTime]::UtcNow).TotalSeconds)
        if ($left -le 0) { Exit-Timeout '' }
        Start-Sleep -Seconds ([Math]::Min($interval, $left))
    }
} finally {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $tmp
}
