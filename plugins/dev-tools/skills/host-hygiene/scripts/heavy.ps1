# heavy.ps1 [--] <command...>   run a command holding a machine-wide heavy slot
# heavy.ps1 --status            print slots, leases and registered services
#
# Refuses on low disk; waits (with a timeout) for a slot and for CPU. Env and paths: lib.ps1.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')

$argv = @($args)
if ($argv.Count -gt 0 -and $argv[0] -eq '--status') { Get-HostStatus; exit 0 }
if ($argv.Count -gt 0 -and $argv[0] -eq '--') { $argv = @($argv | Select-Object -Skip 1) }
if ($argv.Count -eq 0) { [Console]::Error.WriteLine('usage: heavy.ps1 [--] <command...> | --status'); exit 2 }

Assert-HostDisk
$code = 1
try {
    Enter-HostSlot ($argv -join ' ')
    $cmd = $argv[0]; $rest = @($argv | Select-Object -Skip 1)
    $global:LASTEXITCODE = 0
    & $cmd @rest
    $ok = $?
    $code = if ($global:LASTEXITCODE) { $global:LASTEXITCODE } elseif ($ok) { 0 } else { 1 }
} finally {
    Exit-HostSlot
}
exit $code
