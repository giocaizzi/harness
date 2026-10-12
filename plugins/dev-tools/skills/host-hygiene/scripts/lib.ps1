# lib.ps1: shared host-hygiene helpers, dot-sourced by heavy.ps1, lease.ps1, register-service.ps1.
# Lock order lives here: heavy slot first, then a device lease. Never the reverse.
#
# Contract (stable; never rename these, a second path is a second, parallel semaphore):
#   heavy slot n     named mutex 'Global\host-heavy<HOST_LOCK_DIR>-<n>'; the OS hands an abandoned
#                    one (dead holder) to the next waiter. Holder info: $HOST_LOCK_DIR/heavy.slot.<n>
#   device lease     $HOST_LOCK_DIR/<class>.lease, "<owner> <pid> [device]", created exclusively
#   service entry    $HOST_LOCK_DIR/host-services/<pid>, removed on exit
# Env: HOST_LOCK_DIR (Windows %ProgramData%\host-locks, machine-wide; elsewhere /tmp),
#      HOST_HEAVY_SLOTS (2), HOST_CPU_CAP (75 percent; Windows has no load average),
#      HOST_DISK_FLOOR_GB (20), HOST_LOCK_TIMEOUT_SECONDS (1800), HOST_POLL_SECONDS (30), HOST_OWNER.
# %ProgramData% survives reboots, so a lease counts as alive only if its pid started before the lease was written.

$script:OnWindows = $IsWindows -or $PSVersionTable.PSEdition -eq 'Desktop'
$script:HostLockDir = if ($env:HOST_LOCK_DIR) { $env:HOST_LOCK_DIR } elseif ($script:OnWindows) { Join-Path $env:ProgramData 'host-locks' } else { '/tmp' }
$script:HostHeavySlots = if ($env:HOST_HEAVY_SLOTS) { [int]$env:HOST_HEAVY_SLOTS } else { 2 }
$script:HostCpuCap = if ($env:HOST_CPU_CAP) { [double]$env:HOST_CPU_CAP } else { 75 }
$script:HostDiskFloorGb = if ($env:HOST_DISK_FLOOR_GB) { [double]$env:HOST_DISK_FLOOR_GB } else { 20 }
$script:HostLockTimeoutSeconds = if ($env:HOST_LOCK_TIMEOUT_SECONDS) { [int]$env:HOST_LOCK_TIMEOUT_SECONDS } else { 1800 }
$script:HostPollSeconds = if ($env:HOST_POLL_SECONDS) { [int]$env:HOST_POLL_SECONDS } else { 30 }
$script:HostOwner = $(if ($env:HOST_OWNER) { $env:HOST_OWNER } else { "$([Environment]::UserName)@$(Split-Path -Leaf (Get-Location))" }) -replace '\s', '_'
$script:HostMutexPrefix = 'Global\host-heavy' + ($script:HostLockDir -replace '[^A-Za-z0-9]', '_')
$script:HostDeadline = (Get-Date).AddSeconds($script:HostLockTimeoutSeconds)
$script:HostMutex = $null
$script:HostSlotInfo = $null
New-Item -ItemType Directory -Force -Path $script:HostLockDir | Out-Null

function Write-HostSay([string]$Message) { [Console]::Error.WriteLine("host: $Message") }

function Test-HostAlive([string]$ProcessId, $Since) {
    if (-not ($ProcessId -match '^[1-9][0-9]*$')) { return $false }
    try { $p = Get-Process -Id ([int]$ProcessId) -ErrorAction Stop } catch { return $false }
    if (-not $Since) { return $true }
    try { return $p.StartTime -le $Since } catch { return $true } # no access to StartTime: assume alive
}

function Get-HostLeasePid([string]$Path) {
    try { ((Get-Content -LiteralPath $Path -Raw -ErrorAction Stop) -split '\s+')[1] } catch { $null }
}

function Test-HostLeaseAlive([string]$Path) {
    $f = Get-Item -LiteralPath $Path -ErrorAction SilentlyContinue
    if (-not $f) { return $false }
    Test-HostAlive (Get-HostLeasePid $Path) $f.LastWriteTime
}

# Free space does not recover by itself: fail fast instead of waiting.
function Assert-HostDisk {
    $root = [IO.Path]::GetPathRoot((Get-Location).ProviderPath)
    $free = [Math]::Floor((New-Object IO.DriveInfo $root).AvailableFreeSpace / 1GB)
    if ($free -lt $script:HostDiskFloorGb) {
        Write-HostSay "refusing, $free GB free < $($script:HostDiskFloorGb) GB (HOST_DISK_FLOOR_GB). Clean your own leftovers first."
        exit 1
    }
}

function Get-HostCpu {
    if ($script:OnWindows) {
        (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
    } else { 0 } # ponytail: CPU wait is Windows-only; macOS/Linux use heavy.sh and its load cap
}

function Test-HostTimedOut { (Get-Date) -ge $script:HostDeadline }

# Move a dead holder's lease aside, then re-read it. If it changed hands (or its pid is alive again),
# put it back, but only when nothing took its place: never move over an existing path.
function Invoke-HostReclaim([string]$Path, [string]$ProcessId) {
    $aside = "$Path.stale.$PID"
    try { Move-Item -LiteralPath $Path -Destination $aside -ErrorAction Stop } catch { return $false }
    $now = Get-HostLeasePid $aside
    if ($now -ne $ProcessId -or (Test-HostLeaseAlive $aside)) {
        if (-not (Test-Path -LiteralPath $Path)) { Move-Item -LiteralPath $aside -Destination $Path -ErrorAction SilentlyContinue }
        return $false
    }
    Write-HostSay "recovered stale $(Split-Path -Leaf $Path) (pid $ProcessId is gone)"
    Remove-Item -LiteralPath $aside -Force -ErrorAction SilentlyContinue
    $true
}

# Take one of HOST_HEAVY_SLOTS slots, then wait for CPU to fall under HOST_CPU_CAP.
function Enter-HostSlot([string]$Command) {
    $said = $false
    while (-not $script:HostMutex) {
        for ($i = 1; $i -le $script:HostHeavySlots -and -not $script:HostMutex; $i++) {
            $m = New-Object Threading.Mutex($false, "$($script:HostMutexPrefix)-$i")
            try { $got = $m.WaitOne(0) } catch [Threading.AbandonedMutexException] {
                Write-HostSay "recovered stale heavy slot $i (holder is gone)"; $got = $true
            }
            if ($got) { $script:HostMutex = $m; $script:HostSlotInfo = Join-Path $script:HostLockDir "heavy.slot.$i" } else { $m.Dispose() }
        }
        if ($script:HostMutex) { break }
        if (Test-HostTimedOut) { Write-HostSay "gave up waiting for a heavy slot after $($script:HostLockTimeoutSeconds)s"; exit 124 }
        if (-not $said) { Write-HostSay 'waiting for a heavy slot'; $said = $true }
        Start-Sleep -Seconds 2
    }
    Set-Content -LiteralPath $script:HostSlotInfo -Value "$($script:HostOwner) $PID $Command"
    $said = $false
    while ((Get-HostCpu) -gt $script:HostCpuCap) {
        if (Test-HostTimedOut) { Write-HostSay "gave up waiting for cpu to drop under $($script:HostCpuCap)%"; exit 124 }
        if (-not $said) { Write-HostSay "waiting for cpu to drop under $($script:HostCpuCap)% (HOST_CPU_CAP)"; $said = $true }
        Start-Sleep -Seconds $script:HostPollSeconds
    }
}

# Release only what this process holds: a waiter that gave up must never free the holder's slot.
function Exit-HostSlot {
    if ($script:HostSlotInfo -and (Get-HostLeasePid $script:HostSlotInfo) -eq "$PID") {
        Remove-Item -LiteralPath $script:HostSlotInfo -ErrorAction SilentlyContinue
    }
    if ($script:HostMutex) { $script:HostMutex.ReleaseMutex(); $script:HostMutex.Dispose() }
    $script:HostMutex = $null; $script:HostSlotInfo = $null
}

function Get-HostStatus {
    Get-ChildItem -LiteralPath $script:HostLockDir -Filter 'heavy.slot.*' | ForEach-Object { "slot $($_.Extension.TrimStart('.')): $((Get-Content $_.FullName -Raw).Trim())" }
    Get-ChildItem -LiteralPath $script:HostLockDir -Filter '*.lease' | ForEach-Object {
        "lease $($_.Name): $((Get-Content $_.FullName -Raw).Trim())$(if (-not (Test-HostLeaseAlive $_.FullName)) { ' (stale)' })"
    }
    Get-HostService
    "cpu $(Get-HostCpu)% (cap $($script:HostCpuCap)), slots $($script:HostHeavySlots)"
}

function Get-HostService {
    $reg = Join-Path $script:HostLockDir 'host-services'
    Get-ChildItem -LiteralPath $reg -File -ErrorAction SilentlyContinue | ForEach-Object {
        "service: $((Get-Content $_.FullName) -join ' ')$(if (-not (Test-HostAlive $_.Name)) { ' (orphan entry)' })"
    }
}
