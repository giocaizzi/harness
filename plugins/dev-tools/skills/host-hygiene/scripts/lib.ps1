# lib.ps1: shared host-hygiene helpers, dot-sourced by heavy.ps1, lease.ps1, register-service.ps1.
# Lock order lives here: heavy slot first, then a device lease. Never the reverse.
#
# Contract (stable; never rename these, a second path is a second, parallel semaphore):
#   heavy slot n     named mutex 'Global\host-heavy<HOST_LOCK_DIR>-<n>'; the OS hands an abandoned
#                    one (dead holder) to the next waiter. Holder info: $HOST_LOCK_DIR/heavy.slot.<n>
#   heavy waiter     $HOST_LOCK_DIR/heavy.wait.<pid>, a waiter's place in the queue, "<cpu cap> <owner> <cmd>",
#                    served oldest first among the waiters whose cap the current CPU meets
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
$script:HostWaitFile = $null
New-Item -ItemType Directory -Force -Path $script:HostLockDir | Out-Null

function Write-HostSay([string]$Message) { [Console]::Error.WriteLine("host: $Message") }

# alive, gone, or reused (the pid belongs to a process started after $Since).
function Get-HostHolder([string]$ProcessId, $Since) {
    if (-not ($ProcessId -match '^[1-9][0-9]*$')) { return 'gone' }
    try { $p = Get-Process -Id ([int]$ProcessId) -ErrorAction Stop } catch { return 'gone' }
    if (-not $Since) { return 'alive' }
    try { if ($p.StartTime -le $Since) { 'alive' } else { 'reused' } } catch { 'alive' } # no access to StartTime: assume alive
}

function Test-HostAlive([string]$ProcessId, $Since) { (Get-HostHolder $ProcessId $Since) -eq 'alive' }

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

function Get-HostAge($Item) { [int][Math]::Floor(((Get-Date) - $Item.LastWriteTime).TotalSeconds) }

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

# Slots whose holder info names no live holder. The mutex decides; this only orders the queue.
function Get-HostFreeSlot {
    $held = @(Get-ChildItem -LiteralPath $script:HostLockDir -Filter 'heavy.slot.*' | Where-Object { Test-HostLeaseAlive $_.FullName }).Count
    [Math]::Max(0, $script:HostHeavySlots - $held)
}

# Live waiters queued before this one (an older wait file, or the same time and a lower pid) whose own CPU
# cap $Cpu meets: a waiter held back by a lower cap does not hold up the queue.
function Get-HostAhead([double]$Cpu) {
    $mine = (Get-Item -LiteralPath $script:HostWaitFile).LastWriteTime
    @(Get-ChildItem -LiteralPath $script:HostLockDir -Filter 'heavy.wait.*' | Where-Object {
            $p = $_.Extension.TrimStart('.')
            $cap = 0.0
            $p -ne "$PID" -and ($_.LastWriteTime -lt $mine -or ($_.LastWriteTime -eq $mine -and [int]$p -lt $PID)) -and
            [double]::TryParse(((Get-Content -LiteralPath $_.FullName -Raw -ErrorAction SilentlyContinue) -split '\s+')[0], 'Float', [Globalization.CultureInfo]::InvariantCulture, [ref]$cap) -and
            $Cpu -le $cap -and (Test-HostAlive $p $_.LastWriteTime)
        }).Count
}

# Wait until CPU is under HOST_CPU_CAP and this waiter is next (oldest wait file first), take a free slot,
# then re-check CPU and give the slot back if it rose. No slot is held while waiting, so idle waiters never
# fill the slots and a quiet machine is used within one poll.
function Enter-HostSlot([string]$Command) {
    $said = ''
    $script:HostWaitFile = Join-Path $script:HostLockDir "heavy.wait.$PID"
    Set-Content -LiteralPath $script:HostWaitFile -Value "$($script:HostCpuCap) $($script:HostOwner) $Command"
    while ($true) {
        $cpu = Get-HostCpu
        if ($cpu -gt $script:HostCpuCap) {
            if ($said -ne 'cpu') { Write-HostSay "waiting for cpu $cpu% to drop under $($script:HostCpuCap)% (HOST_CPU_CAP)"; $said = 'cpu' }
            if (Test-HostTimedOut) { Write-HostSay "gave up waiting for cpu to drop under $($script:HostCpuCap)% after $($script:HostLockTimeoutSeconds)s"; exit 124 }
            Start-Sleep -Seconds $script:HostPollSeconds
            continue
        }
        if ((Get-HostAhead $cpu) -lt (Get-HostFreeSlot)) {
            for ($i = 1; $i -le $script:HostHeavySlots -and -not $script:HostMutex; $i++) {
                $m = New-Object Threading.Mutex($false, "$($script:HostMutexPrefix)-$i")
                try { $got = $m.WaitOne(0) } catch [Threading.AbandonedMutexException] {
                    Write-HostSay "recovered stale heavy slot $i (holder is gone)"; $got = $true
                }
                if ($got) { $script:HostMutex = $m; $script:HostSlotInfo = Join-Path $script:HostLockDir "heavy.slot.$i" } else { $m.Dispose() }
            }
        }
        if ($script:HostMutex) {
            if ((Get-HostCpu) -le $script:HostCpuCap) { break }
            $script:HostMutex.ReleaseMutex(); $script:HostMutex.Dispose(); $script:HostMutex = $null; $script:HostSlotInfo = $null
            continue
        }
        if ($said -ne 'slot') { Write-HostSay 'waiting for a heavy slot'; $said = 'slot' }
        if (Test-HostTimedOut) { Write-HostSay "gave up waiting for a heavy slot after $($script:HostLockTimeoutSeconds)s"; exit 124 }
        Start-Sleep -Seconds ([Math]::Min(2, $script:HostPollSeconds))
    }
    Set-Content -LiteralPath $script:HostSlotInfo -Value "$($script:HostOwner) $PID $Command (cpu cap $($script:HostCpuCap)%, $($script:HostHeavySlots) slots)"
    Remove-Item -LiteralPath $script:HostWaitFile -ErrorAction SilentlyContinue
    $script:HostWaitFile = $null
}

# Release only what this process holds: a waiter that gave up must never free the holder's slot.
function Exit-HostSlot {
    if ($script:HostWaitFile) { Remove-Item -LiteralPath $script:HostWaitFile -ErrorAction SilentlyContinue }
    if ($script:HostSlotInfo -and (Get-HostLeasePid $script:HostSlotInfo) -eq "$PID") {
        Remove-Item -LiteralPath $script:HostSlotInfo -ErrorAction SilentlyContinue
    }
    if ($script:HostMutex) { $script:HostMutex.ReleaseMutex(); $script:HostMutex.Dispose() }
    $script:HostMutex = $null; $script:HostSlotInfo = $null; $script:HostWaitFile = $null
}

function Get-HostStatus {
    Get-ChildItem -LiteralPath $script:HostLockDir -Filter 'heavy.slot.*' | ForEach-Object {
        $p = Get-HostLeasePid $_.FullName
        $state = switch (Get-HostHolder $p $_.LastWriteTime) { 'alive' { '' } 'reused' { ', pid reused' } default { if ($p) { ', holder dead' } else { ', no pid' } } }
        "slot $($_.Extension.TrimStart('.')): $((Get-Content $_.FullName -Raw).Trim()) ($(Get-HostAge $_)s$state)"
    }
    Get-ChildItem -LiteralPath $script:HostLockDir -Filter 'heavy.wait.*' | Where-Object { Test-HostAlive $_.Extension.TrimStart('.') $_.LastWriteTime } | ForEach-Object {
        $cap, $rest = (Get-Content $_.FullName -Raw).Trim() -split ' ', 2
        "waiting: pid $($_.Extension.TrimStart('.')) $rest (cpu cap $cap%, $(Get-HostAge $_)s)"
    }
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
