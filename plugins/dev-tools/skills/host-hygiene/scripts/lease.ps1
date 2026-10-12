# lease.ps1 <class> [--device <id>] [--] <command...>
#   Run a command holding a heavy slot and then the machine-wide lease for a device class
#   (e.g. android-emu): one holder per class. Slot first, lease second: the reverse order
#   deadlocks. With --device, a device that was not running at acquire time is shut down on
#   exit; only the lease holder owns the device.
#
# Env (lib.ps1, plus): HOST_DEVICE_RUNNING_CMD (succeeds if {device} runs), HOST_DEVICE_SHUTDOWN_CMD,
#   PowerShell commands with {device} replaced by the id. Example (Android):
#     'adb -s {device} get-state' / 'adb -s {device} emu kill'
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')

function Exit-Usage { [Console]::Error.WriteLine('usage: lease.ps1 <class> [--device <id>] [--] <command...>'); exit 2 }
$argv = @($args)
if ($argv.Count -eq 0) { Exit-Usage }
$class = $argv[0]; $argv = @($argv | Select-Object -Skip 1)
$device = ''
if ($argv.Count -gt 0 -and $argv[0] -eq '--device') {
    if ($argv.Count -lt 2) { Exit-Usage }
    $device = $argv[1]; $argv = @($argv | Select-Object -Skip 2)
}
if ($argv.Count -gt 0 -and $argv[0] -eq '--') { $argv = @($argv | Select-Object -Skip 1) }
if ($argv.Count -eq 0) { Exit-Usage }
if ($device -and -not ($env:HOST_DEVICE_RUNNING_CMD -and $env:HOST_DEVICE_SHUTDOWN_CMD)) {
    [Console]::Error.WriteLine('lease: --device needs HOST_DEVICE_RUNNING_CMD and HOST_DEVICE_SHUTDOWN_CMD (see the header of lease.ps1)')
    exit 2
}
$lease = Join-Path $script:HostLockDir "$class.lease"

function Invoke-Device([string]$Template) {
    $global:LASTEXITCODE = 0
    try { & ([scriptblock]::Create($Template.Replace('{device}', $device))) *> $null; $ok = $? } catch { $ok = $false }
    $ok -and -not $global:LASTEXITCODE
}

Assert-HostDisk
$held = $false; $booted = $false; $code = 1
try {
    Enter-HostSlot ($argv -join ' ')
    $said = $false
    while (-not $held) {
        try {
            $f = [IO.File]::Open($lease, 'CreateNew', 'Write', 'Read')
            $bytes = [Text.Encoding]::ASCII.GetBytes(("$($script:HostOwner) $PID $device").Trim())
            $f.Write($bytes, 0, $bytes.Length); $f.Dispose(); $held = $true; break
        } catch [IO.IOException] { $null = $_ } # exists: someone holds it
        $p = Get-HostLeasePid $lease
        if ($p -and -not (Test-HostLeaseAlive $lease) -and (Invoke-HostReclaim $lease $p)) { continue }
        if (Test-HostTimedOut) { Write-HostSay "gave up waiting for the $class lease after $($script:HostLockTimeoutSeconds)s"; exit 124 }
        if (-not $said) { Write-HostSay "waiting for the $class lease (held by $(Get-Content -LiteralPath $lease -Raw -ErrorAction SilentlyContinue))"; $said = $true }
        Start-Sleep -Seconds 2
    }
    if ($device -and -not (Invoke-Device $env:HOST_DEVICE_RUNNING_CMD)) { $booted = $true }

    $cmd = $argv[0]; $rest = @($argv | Select-Object -Skip 1)
    $global:LASTEXITCODE = 0
    & $cmd @rest
    $ok = $?
    $code = if ($global:LASTEXITCODE) { $global:LASTEXITCODE } elseif ($ok) { 0 } else { 1 }
} finally {
    # Release only what this process holds: a waiter that gave up never touches the holder's lease.
    if ($held -and (Get-HostLeasePid $lease) -eq "$PID") {
        if ($booted) { Write-HostSay "shutting down $device (booted under this lease)"; $null = Invoke-Device $env:HOST_DEVICE_SHUTDOWN_CMD }
        Remove-Item -LiteralPath $lease -ErrorAction SilentlyContinue
    }
    Exit-HostSlot
}
exit $code
