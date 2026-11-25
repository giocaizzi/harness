# lib.ps1: shared host-hygiene helpers, dot-sourced by heavy.ps1, lease.ps1, register-service.ps1.
# Lock order lives here: heavy slot first, then a device lease. Never the reverse.
#
# Contract (stable; never rename these, a second path is a second, parallel semaphore):
#   heavy slot n     named mutex 'Global\host-heavy<HOST_LOCK_DIR>-<n>'; the OS hands an abandoned
#                    one (dead holder) to the next waiter. Holder info: $HOST_LOCK_DIR/heavy.slot.<n>
#   heavy waiter     $HOST_LOCK_DIR/heavy.wait.<pid>, a waiter's place in the queue, "<cpu cap> <owner> <cmd>",
#                    served oldest first among the waiters whose cap the current CPU meets
#   medium slot n    named mutex 'Global\host-medium<HOST_LOCK_DIR>-<n>', holder info $HOST_LOCK_DIR/medium.slot.<n>
#   medium waiter    $HOST_LOCK_DIR/medium.wait.<pid>, same format and rules as the heavy waiter
#   weight class     light | medium | heavy, from <repo>/.heavy-weights then weights.default (first match wins,
#                    no match is heavy): heavy takes a heavy slot, medium a medium slot, light none; medium and
#                    light only wait while CPU is over HOST_CRITICAL_CPU_CAP. lease.ps1 always takes a heavy slot.
#   device lease     $HOST_LOCK_DIR/<class>.lease, "<owner> <pid> [device]", created exclusively
#   service entry    $HOST_LOCK_DIR/host-services/<pid>, removed on exit
# Env: HOST_LOCK_DIR (Windows %ProgramData%\host-locks, machine-wide; elsewhere /tmp),
#      HOST_HEAVY_SLOTS (2), HOST_CPU_CAP (75 percent; Windows has no load average),
#      HOST_MEDIUM_SLOTS (4), HOST_CRITICAL_CPU_CAP (95 percent; the cap for medium and light),
#      HOST_METRICS_FILE (unset: none; heavy.ps1 appends one logfmt line per call),
#      HOST_DISK_FLOOR_GB (20), HOST_LOCK_TIMEOUT_SECONDS (1800), HOST_POLL_SECONDS (30), HOST_OWNER.
# %ProgramData% survives reboots, so a lease counts as alive only if its pid started before the lease was written.

$script:OnWindows = $IsWindows -or $PSVersionTable.PSEdition -eq 'Desktop'
$script:HostLockDir = if ($env:HOST_LOCK_DIR) { $env:HOST_LOCK_DIR } elseif ($script:OnWindows) { Join-Path $env:ProgramData 'host-locks' } else { '/tmp' }
$script:HostHeavySlots = if ($env:HOST_HEAVY_SLOTS) { [int]$env:HOST_HEAVY_SLOTS } else { 2 }
$script:HostCpuCap = if ($env:HOST_CPU_CAP) { [double]$env:HOST_CPU_CAP } else { 75 }
$script:HostMediumSlots = if ($env:HOST_MEDIUM_SLOTS) { [int]$env:HOST_MEDIUM_SLOTS } else { 4 }
$script:HostCriticalCpuCap = if ($env:HOST_CRITICAL_CPU_CAP) { [double]$env:HOST_CRITICAL_CPU_CAP } else { 95 }
$script:HostDiskFloorGb = if ($env:HOST_DISK_FLOOR_GB) { [double]$env:HOST_DISK_FLOOR_GB } else { 20 }
$script:HostLockTimeoutSeconds = if ($env:HOST_LOCK_TIMEOUT_SECONDS) { [int]$env:HOST_LOCK_TIMEOUT_SECONDS } else { 1800 }
$script:HostPollSeconds = if ($env:HOST_POLL_SECONDS) { [int]$env:HOST_POLL_SECONDS } else { 30 }
$script:HostOwner = $(if ($env:HOST_OWNER) { $env:HOST_OWNER } else { "$([Environment]::UserName)@$(Split-Path -Leaf (Get-Location))" }) -replace '\s', '_'
$script:HostMutexPrefix = 'Global\host-heavy' + ($script:HostLockDir -replace '[^A-Za-z0-9]', '_')
$script:HostMediumMutexPrefix = 'Global\host-medium' + ($script:HostLockDir -replace '[^A-Za-z0-9]', '_')
$script:HostDeadline = (Get-Date).AddSeconds($script:HostLockTimeoutSeconds)
$script:HostMutex = $null
$script:HostSlotInfo = $null
$script:HostWaitFile = $null
$script:HostWaitStart = Get-Date
$script:HostWaited = 0
$script:HostWaitLoad = $false
$script:HostWaitSlot = $false
$script:HostRunStart = $null
$script:HostMetric = $null
$script:HostJob = [IntPtr]::Zero
New-Item -ItemType Directory -Force -Path $script:HostLockDir | Out-Null

function Write-HostSay([string]$Message) { [Console]::Error.WriteLine("host: $Message") }

# alive, stopped (every thread suspended), gone, or reused (the pid belongs to a process started after $Since).
function Get-HostHolder([string]$ProcessId, $Since) {
    if (-not ($ProcessId -match '^[1-9][0-9]*$')) { return 'gone' }
    try { $p = Get-Process -Id ([int]$ProcessId) -ErrorAction Stop } catch { return 'gone' }
    try {
        $running = @($p.Threads | Where-Object { $_.ThreadState -ne 'Wait' -or $_.WaitReason -ne 'Suspended' }).Count
        if ($p.Threads.Count -and -not $running) { return 'stopped' }
    } catch { Write-Verbose 'thread states unavailable (non-Windows): never stopped' }
    if (-not $Since) { return 'alive' }
    try { if ($p.StartTime -le $Since) { 'alive' } else { 'reused' } } catch { 'alive' } # no access to StartTime: assume alive
}

# A stopped holder still holds its slot or lease: it may be resumed.
function Test-HostAlive([string]$ProcessId, $Since) { (Get-HostHolder $ProcessId $Since) -in 'alive', 'stopped' }

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

# A pool is a set of slots: heavy (HOST_HEAVY_SLOTS, HOST_CPU_CAP) or medium (HOST_MEDIUM_SLOTS, HOST_CRITICAL_CPU_CAP).
function Get-HostPool([string]$Pool = 'heavy') {
    if ($Pool -eq 'medium') {
        [pscustomobject]@{ Name = 'medium'; Slots = $script:HostMediumSlots; Cap = $script:HostCriticalCpuCap; Prefix = $script:HostMediumMutexPrefix; CapText = 'HOST_CRITICAL_CPU_CAP, medium' }
    } else {
        [pscustomobject]@{ Name = 'heavy'; Slots = $script:HostHeavySlots; Cap = $script:HostCpuCap; Prefix = $script:HostMutexPrefix; CapText = 'HOST_CPU_CAP' }
    }
}

# Slots whose holder info names no live holder. The mutex decides; this only orders the queue.
function Get-HostFreeSlot($Pl) {
    $held = @(Get-ChildItem -LiteralPath $script:HostLockDir -Filter "$($Pl.Name).slot.*" | Where-Object { Test-HostLeaseAlive $_.FullName }).Count
    [Math]::Max(0, $Pl.Slots - $held)
}

# Running waiters queued before this one (an older wait file, or the same time and a lower pid) whose own CPU
# cap $Cpu meets: a waiter held back by a lower cap, or stopped, does not hold up the queue.
function Get-HostAhead($Pl, [double]$Cpu) {
    $mine = (Get-Item -LiteralPath $script:HostWaitFile).LastWriteTime
    @(Get-ChildItem -LiteralPath $script:HostLockDir -Filter "$($Pl.Name).wait.*" | Where-Object {
            $p = $_.Extension.TrimStart('.')
            $cap = 0.0
            $p -ne "$PID" -and ($_.LastWriteTime -lt $mine -or ($_.LastWriteTime -eq $mine -and [int]$p -lt $PID)) -and
            [double]::TryParse(((Get-Content -LiteralPath $_.FullName -Raw -ErrorAction SilentlyContinue) -split '\s+')[0], 'Float', [Globalization.CultureInfo]::InvariantCulture, [ref]$cap) -and
            $Cpu -le $cap -and (Get-HostHolder $p $_.LastWriteTime) -eq 'alive'
        }).Count
}

# "waiting for a heavy slot: position 3 in queue, 2/2 slots busy (alice@app go test ./... 120s; bob@app make lint 30s)"
function Get-HostSlotWaitText($Pl, [int]$Ahead) {
    $held = @(Get-ChildItem -LiteralPath $script:HostLockDir -Filter "$($Pl.Name).slot.*" | Where-Object { Test-HostLeaseAlive $_.FullName } | Sort-Object Name | ForEach-Object {
            $f = "$(Get-Content -LiteralPath $_.FullName -Raw -ErrorAction SilentlyContinue)".Trim() -split ' ', 3
            $cmd = "$($f[2])" -replace '\s*\(cpu cap [^)]*\)$', ''
            if ($cmd.Length -gt 60) { $cmd = $cmd.Substring(0, 60) }
            "$($f[0]) $cmd $(Get-HostAge $_)s"
        })
    "waiting for a $($Pl.Name) slot: position $($Ahead + 1) in queue, $($held.Count)/$($Pl.Slots) slots busy$(if ($held.Count) { " ($($held -join '; '))" })"
}

# Close the wait: how long it lasted, for the metric.
function Complete-HostWait { $script:HostWaited = [int][Math]::Floor(((Get-Date) - $script:HostWaitStart).TotalSeconds) }

# The end-of-call line and the metrics record, once per call; only calls heavy.ps1 classified record anything.
# Never lets a failure to write change the exit code.
function Write-HostMetric([int]$Code) {
    $m = $script:HostMetric
    if (-not $m -or $m.Done) { return }
    $m.Done = $true
    $reason = if ($script:HostWaitLoad -and $script:HostWaitSlot) { 'load+slot' } elseif ($script:HostWaitLoad) { 'load' } elseif ($script:HostWaitSlot) { 'slot' } else { 'none' }
    # Time spent sampling CPU (a slow first CIM query) is not a wait.
    if ($reason -eq 'none') { $script:HostWaited = 0 }
    if ($script:HostWaited -ge 1) {
        Write-HostSay "waited $($script:HostWaited)s ($reason) for $(if ($m.Class -eq 'light') { 'load' } else { "a $($m.Class) slot" })"
    }
    if (-not $env:HOST_METRICS_FILE) { return }
    try {
        $ran = if ($script:HostRunStart) { [int][Math]::Floor(((Get-Date) - $script:HostRunStart).TotalSeconds) } else { 0 }
        $ts = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH':'mm':'ss'Z'", [Globalization.CultureInfo]::InvariantCulture)
        $cmd = (@($m.Argv | Select-Object -First 2) -join ' ') -replace '"', "'"
        $line = "ts=$ts weight=$($m.Class) source=$($m.Source) waited_s=$($script:HostWaited) wait=$reason ran_s=$ran exit=$Code owner=$($script:HostOwner) cmd=`"$cmd`""
        $file = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($env:HOST_METRICS_FILE)
        $dir = Split-Path -Parent $file
        if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        [IO.File]::AppendAllText($file, "$line`n", (New-Object Text.UTF8Encoding $false))
    } catch { Write-Verbose "metrics not written: $($_.Exception.Message)" }
}

# Give up waiting: close the wait, record the call, say so, exit 124.
function Exit-HostGaveUp([string]$What) {
    Complete-HostWait
    Write-HostMetric 124
    Write-HostSay "gave up waiting for $What after $($script:HostLockTimeoutSeconds)s"
    exit 124
}

# light: no slot and no queue; wait only while CPU is over the critical cap.
function Wait-HostCritical([string]$Class) {
    $said = $false
    $script:HostWaitStart = Get-Date
    while ($true) {
        $cpu = Get-HostCpu
        if (-not ($cpu -gt $script:HostCriticalCpuCap)) { break }
        $script:HostWaitLoad = $true
        if (-not $said) { Write-HostSay "waiting for cpu $cpu% to drop under $($script:HostCriticalCpuCap)% (HOST_CRITICAL_CPU_CAP, $Class)"; $said = $true }
        if (Test-HostTimedOut) { Exit-HostGaveUp "cpu to drop under $($script:HostCriticalCpuCap)%" }
        Start-Sleep -Seconds $script:HostPollSeconds
    }
    Complete-HostWait
}

# Wait until CPU is under the pool's cap and this waiter is next (oldest wait file first), take a free slot,
# then re-check CPU and give the slot back if it rose. No slot is held while waiting, so idle waiters never
# fill the slots and a quiet machine is used within one poll.
function Enter-HostSlot([string]$Command, [string]$Pool = 'heavy') {
    $Pl = Get-HostPool $Pool
    $said = ''
    $script:HostWaitStart = Get-Date
    $script:HostWaitFile = Join-Path $script:HostLockDir "$($Pl.Name).wait.$PID"
    Set-Content -LiteralPath $script:HostWaitFile -Value "$($Pl.Cap) $($script:HostOwner) $Command"
    while ($true) {
        $cpu = Get-HostCpu
        if ($cpu -gt $Pl.Cap) {
            $script:HostWaitLoad = $true
            if ($said -ne 'cpu') { Write-HostSay "waiting for cpu $cpu% to drop under $($Pl.Cap)% ($($Pl.CapText))"; $said = 'cpu' }
            if (Test-HostTimedOut) { Exit-HostGaveUp "cpu to drop under $($Pl.Cap)%" }
            Start-Sleep -Seconds $script:HostPollSeconds
            continue
        }
        $ahead = Get-HostAhead $Pl $cpu
        if ($ahead -lt (Get-HostFreeSlot $Pl)) {
            for ($i = 1; $i -le $Pl.Slots -and -not $script:HostMutex; $i++) {
                $m = New-Object Threading.Mutex($false, "$($Pl.Prefix)-$i")
                try { $got = $m.WaitOne(0) } catch [Threading.AbandonedMutexException] {
                    Write-HostSay "recovered stale $($Pl.Name) slot $i (holder is gone)"; $got = $true
                }
                if ($got) { $script:HostMutex = $m; $script:HostSlotInfo = Join-Path $script:HostLockDir "$($Pl.Name).slot.$i" } else { $m.Dispose() }
            }
        }
        if ($script:HostMutex) {
            if ((Get-HostCpu) -le $Pl.Cap) { break }
            $script:HostMutex.ReleaseMutex(); $script:HostMutex.Dispose(); $script:HostMutex = $null; $script:HostSlotInfo = $null
            continue
        }
        $script:HostWaitSlot = $true
        if ($said -ne "slot$ahead") { Write-HostSay (Get-HostSlotWaitText $Pl $ahead); $said = "slot$ahead" }
        if (Test-HostTimedOut) { Exit-HostGaveUp "a $($Pl.Name) slot" }
        Start-Sleep -Seconds ([Math]::Min(2, $script:HostPollSeconds))
    }
    Set-Content -LiteralPath $script:HostSlotInfo -Value "$($script:HostOwner) $PID $Command (cpu cap $($Pl.Cap)%, $($Pl.Slots) slots)"
    Remove-Item -LiteralPath $script:HostWaitFile -ErrorAction SilentlyContinue
    $script:HostWaitFile = $null
    Complete-HostWait
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

# The class of a command line: first match in the repo's .heavy-weights, then weights.default; none is heavy.
# Returns Class and Source (repo:<n>, builtin:<n> or default).
function Get-HostWeight([string[]]$Argv) {
    $line = $Argv -join ' '
    $top = $null
    if (Get-Command git -ErrorAction SilentlyContinue) {
        try { $top = (& git rev-parse --show-toplevel 2>$null); if ($LASTEXITCODE -ne 0) { $top = $null } } catch { $top = $null }
    }
    $files = @()
    if ($top -and (Test-Path -LiteralPath (Join-Path "$top" '.heavy-weights'))) { $files += , @((Join-Path "$top" '.heavy-weights'), 'repo') }
    $files += , @((Join-Path $PSScriptRoot 'weights.default'), 'builtin')
    foreach ($f in $files) {
        $n = 0
        foreach ($raw in @(Get-Content -LiteralPath $f[0] -ErrorAction SilentlyContinue)) {
            $n++
            $t = "$raw".Trim()
            if (-not $t -or $t.StartsWith('#')) { continue }
            $class, $glob = $t -split '\s+', 2
            if ($class -cnotin 'light', 'medium', 'heavy') { Write-HostSay "ignoring $($f[0]):${n}: unknown class '$class'"; continue }
            if ($glob -and $line -clike $glob) { return [pscustomobject]@{ Class = $class; Source = "$($f[1]):$n" } }
        }
    }
    [pscustomobject]@{ Class = 'heavy'; Source = 'default' }
}

# Orphan cleanup: put this process in a Job Object that kills its members when the last handle closes, so a hard
# kill of heavy.ps1 ends everything the command started (children inherit the job). Windows only.
$script:HostJobSource = @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class HostJobNative {
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimit { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters { public ulong A; public ulong B; public ulong C; public ulong D; public ulong E; public ulong F; }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtLimit { public BasicLimit Basic; public IoCounters Io; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
    [StructLayout(LayoutKind.Sequential)]
    struct Accounting { public long TotalUserTime; public long TotalKernelTime; public long ThisPeriodTotalUserTime; public long ThisPeriodTotalKernelTime; public uint TotalPageFaultCount; public uint TotalProcesses; public uint ActiveProcesses; public uint TotalTerminatedProcesses; }
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, uint len);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, IntPtr info, uint len, IntPtr ret);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    public static void SetFlags(IntPtr job, uint flags) {
        ExtLimit info = new ExtLimit();
        info.Basic.LimitFlags = flags;
        IntPtr p = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(ExtLimit)));
        try {
            Marshal.StructureToPtr(info, p, false);
            if (!SetInformationJobObject(job, 9, p, (uint)Marshal.SizeOf(typeof(ExtLimit)))) throw new Win32Exception(Marshal.GetLastWin32Error());
        } finally { Marshal.FreeHGlobal(p); }
    }
    public static IntPtr Create() {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        SetFlags(job, 0x2000);
        if (!AssignProcessToJobObject(job, Process.GetCurrentProcess().Handle)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return job;
    }
    public static uint Active(IntPtr job) {
        IntPtr p = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Accounting)));
        try {
            if (!QueryInformationJobObject(job, 1, p, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return ((Accounting)Marshal.PtrToStructure(p, typeof(Accounting))).ActiveProcesses;
        } finally { Marshal.FreeHGlobal(p); }
    }
}
'@

function Get-HostFirstLine($ErrorRecord) { (($ErrorRecord.Exception.Message -split "`n")[0]).Trim() }

function Enter-HostJob {
    if (-not $script:OnWindows) { return }
    try {
        if (-not ('HostJobNative' -as [type])) { Add-Type -TypeDefinition $script:HostJobSource }
        $script:HostJob = [HostJobNative]::Create()
    } catch { Write-HostSay "no job object ($(Get-HostFirstLine $_)), orphans are not cleaned up" }
}

# The command succeeded: what it left running (a build daemon) survives, so drop the kill-on-close flag.
function Disable-HostJobKill {
    if ($script:HostJob -eq [IntPtr]::Zero) { return }
    try { [HostJobNative]::SetFlags($script:HostJob, 0) } catch { Write-HostSay "job object not cleared ($(Get-HostFirstLine $_)), leftovers will be stopped" }
}

# The command failed: say so when processes besides this one are still in the job (they die when it closes).
function Write-HostJobLeftover {
    if ($script:HostJob -eq [IntPtr]::Zero) { return }
    try { if ([HostJobNative]::Active($script:HostJob) -gt 1) { Write-HostSay 'stopped processes the command left behind' } } catch { Write-Verbose 'job count unavailable' }
}

function Get-HostPoolStatus($Pl, [string]$SlotLabel, [string]$WaitLabel) {
    Get-ChildItem -LiteralPath $script:HostLockDir -Filter "$($Pl.Name).slot.*" | ForEach-Object {
        $p = Get-HostLeasePid $_.FullName
        $state = switch (Get-HostHolder $p $_.LastWriteTime) { 'alive' { '' } 'reused' { ', pid reused' } 'stopped' { ', holder stopped' } default { if ($p) { ', holder dead' } else { ', no pid' } } }
        "$SlotLabel $($_.Extension.TrimStart('.')): $((Get-Content $_.FullName -Raw).Trim()) ($(Get-HostAge $_)s$state)"
    }
    Get-ChildItem -LiteralPath $script:HostLockDir -Filter "$($Pl.Name).wait.*" | Where-Object { Test-HostAlive $_.Extension.TrimStart('.') $_.LastWriteTime } | ForEach-Object {
        $cap, $rest = (Get-Content $_.FullName -Raw).Trim() -split ' ', 2
        "${WaitLabel}: pid $($_.Extension.TrimStart('.')) $rest (cpu cap $cap%, $(Get-HostAge $_)s)"
    }
}

function Get-HostStatus {
    Get-HostPoolStatus -Pl (Get-HostPool 'heavy') -SlotLabel 'slot' -WaitLabel 'waiting'
    Get-HostPoolStatus -Pl (Get-HostPool 'medium') -SlotLabel 'medium slot' -WaitLabel 'waiting medium'
    Get-ChildItem -LiteralPath $script:HostLockDir -Filter '*.lease' | ForEach-Object {
        "lease $($_.Name): $((Get-Content $_.FullName -Raw).Trim())$(if (-not (Test-HostLeaseAlive $_.FullName)) { ' (stale)' })"
    }
    Get-HostService
    "cpu $(Get-HostCpu)% (cap $($script:HostCpuCap), critical $($script:HostCriticalCpuCap)), slots $($script:HostHeavySlots), medium slots $($script:HostMediumSlots)"
}

function Get-HostService {
    $reg = Join-Path $script:HostLockDir 'host-services'
    Get-ChildItem -LiteralPath $reg -File -ErrorAction SilentlyContinue | ForEach-Object {
        "service: $((Get-Content $_.FullName) -join ' ')$(if (-not (Test-HostAlive $_.Name)) { ' (orphan entry)' })"
    }
}
