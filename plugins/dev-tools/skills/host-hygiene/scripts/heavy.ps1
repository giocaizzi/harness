# heavy.ps1 [--] <command...>              run a command under its weight class: a heavy slot, a medium slot, or none (light)
# heavy.ps1 --classify [--] <command...>   print "<class> <source>" and run nothing
# heavy.ps1 --status                       print slots, leases and registered services
#
# The class comes from <repo>/.heavy-weights, then weights.default; no match is heavy. Refuses on low disk; waits
# (with a timeout) for a slot and for CPU. The process runs in a Job Object: a failed or killed run ends every
# process the command started. Env and paths: lib.ps1.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')

$argv = @($args)
if ($argv.Count -gt 0 -and $argv[0] -eq '--status') { Get-HostStatus; exit 0 }
$classify = $argv.Count -gt 0 -and $argv[0] -eq '--classify'
if ($classify) { $argv = @($argv | Select-Object -Skip 1) }
if ($argv.Count -gt 0 -and $argv[0] -eq '--') { $argv = @($argv | Select-Object -Skip 1) }
if ($argv.Count -eq 0) { [Console]::Error.WriteLine('usage: heavy.ps1 [--] <command...> | --classify [--] <command...> | --status'); exit 2 }

$weight = Get-HostWeight $argv
if ($classify) { "$($weight.Class) $($weight.Source)"; exit 0 }

Assert-HostDisk
$script:HostMetric = @{ Class = $weight.Class; Source = $weight.Source; Argv = $argv; Done = $false }
$code = 1
try {
    if ($weight.Class -eq 'light') { Wait-HostCritical 'light' } else { Enter-HostSlot ($argv -join ' ') $weight.Class }
    Enter-HostJob
    $cmd = $argv[0]; $rest = @($argv | Select-Object -Skip 1)
    $global:LASTEXITCODE = 0
    $script:HostRunStart = Get-Date
    & $cmd @rest
    $ok = $?
    $code = if ($global:LASTEXITCODE) { $global:LASTEXITCODE } elseif ($ok) { 0 } else { 1 }
    if ($code -eq 0) { Disable-HostJobKill } else { Write-HostJobLeftover }
} finally {
    Exit-HostSlot
    Write-HostMetric $code
}
exit $code
