# register-service.ps1 <name> [--] <command...>   run a long-lived service, registered while it runs
# register-service.ps1 --list                      print registered services; dead ones are orphan entries
#
# Writes $HOST_LOCK_DIR/host-services/<pid of this wrapper> (owner, name, service pid, start time,
# command), removed on exit; Ctrl+C stops the service too. Killing the wrapper hard (Stop-Process)
# skips that cleanup and leaves an orphan entry. Env: lib.ps1 (HOST_OWNER names the session).
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')

$argv = @($args)
if ($argv.Count -gt 0 -and $argv[0] -eq '--list') { Get-HostService; exit 0 }
$name = if ($argv.Count -gt 0) { $argv[0] } else { '' }
$argv = @($argv | Select-Object -Skip 1)
if ($argv.Count -gt 0 -and $argv[0] -eq '--') { $argv = @($argv | Select-Object -Skip 1) }
if (-not $name -or $argv.Count -eq 0) { [Console]::Error.WriteLine('usage: register-service.ps1 <name> [--] <command...> | --list'); exit 2 }

$reg = Join-Path $script:HostLockDir 'host-services'
New-Item -ItemType Directory -Force -Path $reg | Out-Null
$entry = Join-Path $reg $PID
$proc = $null
try {
    $start = @{ FilePath = $argv[0]; NoNewWindow = $true; PassThru = $true }
    # ponytail: Start-Process joins arguments with spaces; quote an argument that contains one
    if ($argv.Count -gt 1) { $start.ArgumentList = @($argv | Select-Object -Skip 1) }
    $proc = Start-Process @start
    $null = $proc.Handle # without a cached handle, ExitCode stays empty
    Set-Content -LiteralPath $entry -Value @(
        "owner=$($script:HostOwner)", "name=$name", "pid=$($proc.Id)",
        "started=$((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))", "cmd=$($argv -join ' ')")
    $proc.WaitForExit()
    $code = $proc.ExitCode
} finally {
    if ($proc -and -not $proc.HasExited) { $proc.Kill() }
    Remove-Item -LiteralPath $entry -ErrorAction SilentlyContinue
}
exit $code
