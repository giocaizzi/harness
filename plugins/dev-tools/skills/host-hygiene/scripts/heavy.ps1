# heavy.ps1 [--] <command...>   run a command holding a machine-wide heavy slot
# heavy.ps1 --status            print holders
#
# Env: HEAVY_SLOTS (1), HEAVY_CPU_MAX (75 percent; Windows has no load average),
#      HEAVY_DISK_MIN_GB (20), HEAVY_STATE_DIR (per-user temp dir, holds holder info).
# Slots are named mutexes: the OS hands an abandoned one (dead holder) to the next waiter.
$ErrorActionPreference = 'Stop'

$argv = @($args)
$slots = if ($env:HEAVY_SLOTS) { [int]$env:HEAVY_SLOTS } else { 1 }
# Stays under the guard plugin's cpuPercentCap (90), so heavy.ps1 waits before guard denies.
$cpuMax = if ($env:HEAVY_CPU_MAX) { [double]$env:HEAVY_CPU_MAX } else { 75 }
$diskMin = if ($env:HEAVY_DISK_MIN_GB) { [double]$env:HEAVY_DISK_MIN_GB } else { 20 }
$dir = if ($env:HEAVY_STATE_DIR) { $env:HEAVY_STATE_DIR } else { Join-Path ([IO.Path]::GetTempPath()) 'heavy' }
# The mutex name derives from the state dir, which is per user (%TEMP%), so slots are per user too.
$prefix = 'Global\heavy' + ($dir -replace '[^A-Za-z0-9]', '_')
New-Item -ItemType Directory -Force -Path $dir | Out-Null

function Get-Cpu {
    if ($IsWindows -or $PSVersionTable.PSEdition -eq 'Desktop') {
        (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
    } else { 0 } # ponytail: CPU wait is Windows-only; macOS/Linux use heavy.sh
}

if ($argv.Count -gt 0 -and $argv[0] -eq '--status') {
    Get-ChildItem $dir -Filter 'slot.*' | ForEach-Object { 'held: ' + (Get-Content $_.FullName -Raw).Trim() }
    "cpu $(Get-Cpu)% (max $cpuMax), slots $slots"
    exit 0
}
if ($argv.Count -gt 0 -and $argv[0] -eq '--') { $argv = @($argv | Select-Object -Skip 1) }
if ($argv.Count -eq 0) { [Console]::Error.WriteLine('usage: heavy.ps1 [--] <command...> | --status'); exit 2 }

$root = [IO.Path]::GetPathRoot((Get-Location).ProviderPath)
$free = [Math]::Floor((New-Object IO.DriveInfo $root).AvailableFreeSpace / 1GB)
if ($free -lt $diskMin) {
    [Console]::Error.WriteLine("heavy: refusing, $free GB free < $diskMin GB (HEAVY_DISK_MIN_GB). Clean your own leftovers first.")
    exit 1
}

$mutex = $null; $info = $null; $said = $false
try {
    while (-not $mutex) {
        for ($i = 1; $i -le $slots -and -not $mutex; $i++) {
            $m = New-Object Threading.Mutex($false, "$prefix-$i")
            try { $got = $m.WaitOne(0) } catch [Threading.AbandonedMutexException] {
                [Console]::Error.WriteLine("heavy: recovering stale slot $i (holder is gone)"); $got = $true
            }
            if ($got) { $mutex = $m; $info = Join-Path $dir "slot.$i" } else { $m.Dispose() }
        }
        if (-not $mutex) {
            if (-not $said) { [Console]::Error.WriteLine('heavy: waiting for a slot'); $said = $true }
            Start-Sleep -Seconds 2
        }
    }
    Set-Content -Path $info -Value "pid $PID $($argv -join ' ')"

    $said = $false
    while ((Get-Cpu) -gt $cpuMax) {
        if (-not $said) { [Console]::Error.WriteLine("heavy: waiting for cpu to drop under $cpuMax%"); $said = $true }
        Start-Sleep -Seconds 5
    }

    $cmd = $argv[0]; $rest = @($argv | Select-Object -Skip 1)
    $global:LASTEXITCODE = 0
    & $cmd @rest
    $ok = $?
    $code = if ($global:LASTEXITCODE) { $global:LASTEXITCODE } elseif ($ok) { 0 } else { 1 }
} finally {
    if ($info) { Remove-Item $info -ErrorAction SilentlyContinue }
    if ($mutex) { $mutex.ReleaseMutex(); $mutex.Dispose() }
}
exit $code
