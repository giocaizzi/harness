# Tests for plugins/dev-tools/skills/host-hygiene/scripts/*.ps1 (run by `make test` when pwsh is on PATH).
$ErrorActionPreference = 'Stop'
$scripts = Join-Path $PSScriptRoot '../plugins/dev-tools/skills/host-hygiene/scripts'
$heavy = Join-Path $scripts 'heavy.ps1'
$lease = Join-Path $scripts 'lease.ps1'
$reg = Join-Path $scripts 'register-service.ps1'
$sweep = Join-Path $scripts 'sweep-stale.ps1'
$tmp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid())
$L = Join-Path $tmp 'locks'
$env:HOST_LOCK_DIR = $L
$env:HOST_DISK_FLOOR_GB = '0'
$env:HOST_HEAVY_SLOTS = '1'
$env:HOST_CPU_CAP = '100'
$shell = (Get-Process -Id $PID).Path
$windowStyle = if ($env:OS -eq 'Windows_NT') { @{ WindowStyle = 'Hidden' } } else { @{} }
function Invoke-Heavy([string]$Command) {
    Start-Process $shell -ArgumentList "-NoProfile -File `"$heavy`" `"$shell`" -NoProfile -Command `"$Command`"" @windowStyle -PassThru
}
$mutex1 = 'Global\host-heavy' + ($L -replace '[^A-Za-z0-9]', '_') + '-1'
$script:fails = 0
function Test-Equal([string]$Name, $Got, $Want) {
    if ("$Got" -eq "$Want") { "ok - $Name" } else { "not ok - ${Name}: got '$Got', want '$Want'"; $script:fails++ }
}
function Invoke-Shell([string]$Command, [string]$Dir = $tmp) {
    Start-Process $shell -ArgumentList '-NoProfile', '-Command', $Command -WorkingDirectory $Dir @windowStyle -PassThru
}
function Get-DeadPid { $p = Invoke-Shell 'exit 0'; $p.WaitForExit(); $p.Id }
function Invoke-SlotHolder { $h = Invoke-Shell "`$m = New-Object Threading.Mutex(`$false, '$mutex1'); [void]`$m.WaitOne(); Start-Sleep 8"; Start-Sleep 2; $h }
New-Item -ItemType Directory -Path $tmp | Out-Null
$log = Join-Path $tmp 'log'
try {
    # heavy.ps1
    $slow = "Add-Content '$log' start; Start-Sleep 2; Add-Content '$log' end"
    $fast = "Add-Content '$log' start; Add-Content '$log' end"
    $a = Invoke-Heavy $slow
    Start-Sleep -Milliseconds 1000
    $b = Invoke-Heavy $fast
    $a, $b | Wait-Process
    Test-Equal -Name 'one slot: concurrent runs serialize' -Got ((Get-Content $log) -join ' ') -Want 'start end start end'

    Remove-Item $log
    $env:HOST_HEAVY_SLOTS = '2'
    $a = Invoke-Heavy $slow
    Start-Sleep -Milliseconds 1000
    $b = Invoke-Heavy $fast
    $a, $b | Wait-Process
    $env:HOST_HEAVY_SLOTS = '1'
    Test-Equal -Name 'two slots: runs overlap' -Got ((Get-Content $log) -join ' ') -Want 'start start end end'

    & $shell -NoProfile -File $heavy $shell -NoProfile -Command 'exit 7'
    Test-Equal -Name 'exit code propagates' -Got $LASTEXITCODE -Want 7

    # A holder that exits without releasing leaves an abandoned mutex; the next run takes it.
    & $shell -NoProfile -Command "`$m = New-Object Threading.Mutex(`$false, '$mutex1'); [void]`$m.WaitOne(); exit 0"
    & $shell -NoProfile -File $heavy $shell -NoProfile -Command 'exit 0' 2>$null
    Test-Equal -Name 'stale slot recovered' -Got $LASTEXITCODE -Want 0

    $env:HOST_DISK_FLOOR_GB = '999999999'
    & $shell -NoProfile -File $heavy $shell -NoProfile -Command "New-Item '$tmp/ran'" 2>$null
    Test-Equal -Name 'low disk refuses' -Got "$LASTEXITCODE $(Test-Path "$tmp/ran")" -Want '1 False'
    $env:HOST_DISK_FLOOR_GB = '0'

    # Release own only: a waiter that gives up leaves the holder's slot alone.
    $env:HOST_LOCK_TIMEOUT_SECONDS = '1'
    $h = Invoke-SlotHolder
    Set-Content (Join-Path $L 'heavy.slot.1') "other $($h.Id) cmd"
    & $shell -NoProfile -File $heavy $shell -NoProfile -Command 'exit 0' 2>$null
    Test-Equal -Name 'timed-out waiter exits 124 and keeps the holder''s slot' -Got "$LASTEXITCODE $(Get-Content (Join-Path $L 'heavy.slot.1'))" -Want "124 other $($h.Id) cmd"

    # lease.ps1: slot first, then lease.
    & $shell -NoProfile -File $lease sim -- $shell -NoProfile -Command "Test-Path '$L/sim.lease'" 2>$null
    Test-Equal -Name 'slot before lease: no lease taken while waiting for a slot' -Got "$LASTEXITCODE $(Test-Path "$L/sim.lease")" -Want '124 False'
    $h | Wait-Process
    $env:HOST_LOCK_TIMEOUT_SECONDS = '1800'

    $held = Join-Path $tmp 'held'
    & $shell -NoProfile -File $lease sim -- $shell -NoProfile -Command "Get-Content '$L/heavy.slot.1', '$L/sim.lease' | Set-Content '$held'"
    Test-Equal -Name 'lease holds slot and lease while running' -Got (Get-Content $held).Count -Want 2
    Test-Equal -Name 'lease releases both' -Got @(Get-ChildItem $L -Filter '*.lease').Count -Want 0

    $env:HOST_LOCK_TIMEOUT_SECONDS = '1'
    Set-Content "$L/sim.lease" "other $PID"
    & $shell -NoProfile -File $lease sim -- $shell -NoProfile -Command 'exit 0' 2>$null
    Test-Equal -Name 'timed-out lease waiter keeps the holder''s lease' -Got "$LASTEXITCODE $(Get-Content "$L/sim.lease")" -Want "124 other $PID"
    $env:HOST_LOCK_TIMEOUT_SECONDS = '1800'
    Set-Content "$L/sim.lease" "other $(Get-DeadPid)"
    & $shell -NoProfile -File $lease sim -- $shell -NoProfile -Command 'exit 0' 2>$null
    Test-Equal -Name 'stale lease recovered' -Got "$LASTEXITCODE $(@(Get-ChildItem $L -Filter 'sim.lease*').Count)" -Want '0 0'

    $env:HOST_DEVICE_SHUTDOWN_CMD = "Add-Content '$tmp/shutdown' {device}"
    $env:HOST_DEVICE_RUNNING_CMD = "& '$shell' -NoProfile -Command 'exit 1'"
    & $shell -NoProfile -File $lease sim --device dev-1 -- $shell -NoProfile -Command 'exit 0' 2>$null
    $env:HOST_DEVICE_RUNNING_CMD = "& '$shell' -NoProfile -Command 'exit 0'"
    & $shell -NoProfile -File $lease sim --device dev-2 -- $shell -NoProfile -Command 'exit 0' 2>$null
    Test-Equal -Name 'device booted under the lease is shut down, a running one is not' -Got (Get-Content "$tmp/shutdown") -Want 'dev-1'
    $env:HOST_DEVICE_RUNNING_CMD = ''
    & $shell -NoProfile -File $lease sim --device dev-3 -- $shell -NoProfile -Command 'exit 0' 2>$null
    Test-Equal -Name '--device without device commands is refused' -Got $LASTEXITCODE -Want 2

    # CPU first, slot second: a waiter holds no slot while CPU is over the cap, takes one within a poll once
    # it drops, and gives it back if CPU rose by the time it got it. CPU is simulated: Get-HostCpu pops the
    # next value from a file (the last one repeats) and traces whether a slot is held.
    $cpu = Join-Path $tmp 'cpu'; $trace = Join-Path $tmp 'trace'; $got = Join-Path $tmp 'got'
    $waiter = Join-Path $tmp 'waiter.ps1'
    Set-Content $waiter @'
. (Join-Path $env:TEST_SCRIPTS 'lib.ps1')
function Get-HostCpu {
    $v = @(Get-Content $env:TEST_CPU)
    if ($v.Count -gt 1) { Set-Content $env:TEST_CPU $v[1..($v.Count - 1)] }
    Add-Content $env:TEST_TRACE ([int][bool]$script:HostMutex)
    [double]$v[0]
}
try { Enter-HostSlot job; Set-Content $env:TEST_GOT (Get-Date).ToString('o') } finally { Exit-HostSlot }
'@
    $env:TEST_SCRIPTS = $scripts; $env:TEST_CPU = $cpu; $env:TEST_TRACE = $trace; $env:TEST_GOT = $got
    $env:HOST_CPU_CAP = '10'; $env:HOST_POLL_SECONDS = '1'; $env:HOST_LOCK_TIMEOUT_SECONDS = '15'
    Set-Content $cpu 99
    $w = Start-Process $shell -ArgumentList "-NoProfile -File `"$waiter`"" @windowStyle -PassThru
    Start-Sleep 3
    $m = New-Object Threading.Mutex($false, $mutex1)
    $free = $m.WaitOne(0); if ($free) { $m.ReleaseMutex() }; $m.Dispose()
    Test-Equal -Name 'cpu over the cap: the waiter holds no slot' -Got $free -Want $true
    Set-Content $cpu 1; $dropped = Get-Date
    $w | Wait-Process
    # One 1 s poll, plus pwsh's own overhead on a slow runner.
    Test-Equal -Name 'cpu drops: the waiter takes a slot within one poll' -Got (([datetime](Get-Content $got) - $dropped).TotalSeconds -le 3) -Want $true
    Set-Content $cpu 1, 99, 99, 1
    Remove-Item $trace
    & $shell -NoProfile -File $waiter 2>$null
    Test-Equal -Name 'cpu rose after the slot was taken: slot given back, then retaken' -Got "$LASTEXITCODE $((Get-Content $trace) -join ' ')" -Want '0 0 1 0 0 1'
    # A slow start can pass the deadline before the first check: the wait still says what it waited for.
    $env:HOST_LOCK_TIMEOUT_SECONDS = '0'
    $err = Join-Path $tmp 'err'
    Set-Content $cpu 99
    & $shell -NoProfile -File $waiter 2>$err
    Test-Equal -Name 'a wait past its deadline still reports itself' -Got "$LASTEXITCODE $(@(Select-String -Path $err -Pattern '^host: waiting for cpu').Count)" -Want '124 1'
    $env:HOST_CPU_CAP = '100'; Remove-Item Env:HOST_POLL_SECONDS

    # FIFO: a free slot goes to the oldest live waiter whose CPU cap is met; a dead waiter's entry, or one held
    # back by its own lower cap, does not block.
    $older = Invoke-Shell 'Start-Sleep 20'
    $lower = Invoke-Shell 'Start-Sleep 20'
    Set-Content (Join-Path $L "heavy.wait.$($older.Id)") '100 other'
    Set-Content (Join-Path $L "heavy.wait.$($lower.Id)") '-1 low-cap'
    Start-Sleep -Milliseconds 1100
    $env:HOST_LOCK_TIMEOUT_SECONDS = '1'
    & $shell -NoProfile -File $heavy $shell -NoProfile -Command 'exit 0' 2>$null
    Test-Equal -Name 'a newer waiter leaves a free slot to an older one' -Got $LASTEXITCODE -Want 124
    Test-Equal -Name '--status shows waiters and their cap' -Got @(& $shell -NoProfile -File $heavy --status | Where-Object { $_ -match "^waiting: pid ($($older.Id) other \(cpu cap 100%|$($lower.Id) low-cap \(cpu cap -1%), \d+s\)$" }).Count -Want 2
    Stop-Process -Id $older.Id; $older | Wait-Process
    $env:HOST_LOCK_TIMEOUT_SECONDS = '10'
    & $shell -NoProfile -File $heavy $shell -NoProfile -Command 'exit 0' 2>$null
    Test-Equal -Name 'a dead or lower-cap waiter''s entry does not block the queue' -Got $LASTEXITCODE -Want 0
    Stop-Process -Id $lower.Id; $lower | Wait-Process
    Remove-Item (Join-Path $L 'heavy.wait.*')
    $env:HOST_LOCK_TIMEOUT_SECONDS = '1800'

    # --status: each holder's cap and age, and dead holders flagged.
    $a = Invoke-Heavy 'Start-Sleep 4'
    for ($i = 0; $i -lt 50 -and -not (Test-Path (Join-Path $L 'heavy.slot.1')); $i++) { Start-Sleep -Milliseconds 200 }
    Test-Equal -Name '--status shows the holder''s cap' -Got @(& $shell -NoProfile -File $heavy --status | Where-Object { $_ -match '^slot 1: .* Start-Sleep 4 \(cpu cap 100%, 1 slots\) \(\d+s\)$' }).Count -Want 1
    $a | Wait-Process
    Set-Content (Join-Path $L 'heavy.slot.1') "other $(Get-DeadPid) make"
    Test-Equal -Name '--status flags a dead holder' -Got @(& $shell -NoProfile -File $heavy --status | Where-Object { $_ -match '^slot 1: other \d+ make \(\d+s, holder dead\)$' }).Count -Want 1
    Remove-Item (Join-Path $L 'heavy.slot.1')

    # register-service.ps1
    $w = Start-Process $shell -ArgumentList "-NoProfile -File `"$reg`" db -- `"$shell`" -NoProfile -Command `"Start-Sleep 3`"" @windowStyle -PassThru
    Start-Sleep 2
    Test-Equal -Name 'service registered while running' -Got @(Select-String -Path (Join-Path $L "host-services/$($w.Id)") -Pattern '^name=db$').Count -Want 1
    Test-Equal -Name '--list shows it' -Got @(& $shell -NoProfile -File $reg --list | Select-String 'name=db').Count -Want 1
    $w | Wait-Process
    Test-Equal -Name 'entry removed on exit' -Got @(Get-ChildItem (Join-Path $L 'host-services')).Count -Want 0

    # sweep-stale.ps1
    $repo = Join-Path $tmp 'repo'
    git init -q $repo
    git -C $repo -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
    foreach ($n in 'old', 'recent', 'dirty', 'busy') { git -C $repo worktree add -q (Join-Path $tmp "wt-$n") -b $n 2>$null }
    Set-Content (Join-Path $tmp 'wt-dirty/new') x
    foreach ($n in 'old', 'dirty', 'busy') {
        $d = Join-Path $tmp "wt-$n"
        @(Get-Item $d -Force) + @(Get-ChildItem $d -Recurse -Force) | ForEach-Object { $_.LastWriteTime = [datetime]'2020-01-01' }
    }
    $busy = Invoke-Shell 'Start-Sleep 20' (Join-Path $tmp 'wt-busy')
    Start-Sleep 2
    Push-Location $repo
    $out = @(& $shell -NoProfile -File $sweep)
    Test-Equal -Name 'sweep dry run removes only the old, clean, idle worktree' -Got ((($out | Where-Object { $_ -like 'would remove*' }) -join ';') -replace '\\', '/') -Want ("would remove $(Join-Path $tmp 'wt-old')" -replace '\\', '/')
    Test-Equal -Name 'sweep keeps recent, dirty and busy' -Got @($out | Where-Object { $_ -match 'wt-recent: modified|wt-dirty: uncommitted|wt-busy: in use' }).Count -Want 3
    & $shell -NoProfile -File $sweep --apply | Out-Null
    Test-Equal -Name '--apply removes it' -Got "$(Test-Path (Join-Path $tmp 'wt-old')) $(@(git worktree list).Count)" -Want 'False 4'
    Pop-Location
    Push-Location (Join-Path $tmp 'wt-recent')
    Test-Equal -Name 'sweep never touches the current worktree' -Got @(& $shell -NoProfile -File $sweep | Where-Object { $_ -match 'wt-recent: current' }).Count -Want 1
    Pop-Location
    Stop-Process -Id $busy.Id -ErrorAction SilentlyContinue
    $live = Join-Path $repo '.claude/worktrees/live'
    git -C $repo worktree add -q $live -b live 2>$null
    $orphan = Join-Path $repo '.claude/worktrees/orphan'
    New-Item -ItemType Directory -Force (Join-Path $orphan 'pkg/mod') | Out-Null
    Set-Content (Join-Path $orphan 'pkg/mod/f') x
    (Get-Item (Join-Path $orphan 'pkg/mod/f')).IsReadOnly = $true
    Push-Location $repo
    $out = @(& $shell -NoProfile -File $sweep --apply)
    Pop-Location
    $orphanReal = [IO.Path]::GetFullPath((Resolve-Path $orphan).ProviderPath)
    $prefix = 'unregistered ' + $orphanReal + ' ('
    $listed = @($out | Where-Object { $_.StartsWith($prefix) -and $_.Contains('the owner runs') }).Count
    $liveListed = @($out | Where-Object { $_ -like 'unregistered *worktrees*live*' }).Count
    Test-Equal -Name 'sweep lists an unregistered worktree dir with the owner''s command and leaves it' -Got "$listed$liveListed$(Test-Path (Join-Path $orphan 'pkg/mod/f'))" -Want '10True'
    (Get-Item (Join-Path $orphan 'pkg/mod/f')).IsReadOnly = $false

    # sweep-stale.ps1 --branches
    $origin = Join-Path $tmp 'origin.git'
    $br = Join-Path $tmp 'brrepo'
    git init -q --bare -b main $origin
    git init -q -b main $br
    git -C $br -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
    git -C $br remote add origin $origin
    git -C $br push -q origin main
    foreach ($n in 'orphan', 'open', 'gone') { git -C $br branch $n; git -C $br push -q -u origin $n 2>$null }
    git -C $origin branch -q -D gone
    $env:SWEEP_OPEN_BRANCHES = 'open'
    Push-Location $br
    $out = @(& $shell -NoProfile -File $sweep --branches)
    Test-Equal -Name 'branch sweep reports orphan remote and gone local only' -Got (($out | Sort-Object) -join ';') -Want 'would delete gone: upstream gone;would delete origin/orphan: no open PR'
    Test-Equal -Name 'branch dry run deletes nothing' -Got @(git -C $origin branch).Count -Want 3
    & $shell -NoProfile -File $sweep --branches --apply | Out-Null
    Test-Equal -Name 'branch --apply deletes them, keeps open and default' -Got ((@(git -C $origin branch) + @(git -C $br branch) | ForEach-Object { $_.Trim('* ') } | Sort-Object) -join ' ') -Want 'main main open open'
    Pop-Location
    Remove-Item Env:SWEEP_OPEN_BRANCHES

    # sweep-stale.ps1 --plugins
    $cfg = Join-Path $tmp 'claude'
    $c = Join-Path $cfg 'plugins/cache/mkt'
    foreach ($v in 'p/1.0', 'p/1.1', 'p/0.9', 'p/0.8', 'q/2.0') { New-Item -ItemType Directory -Force (Join-Path $c $v) | Out-Null }
    $c = (Resolve-Path $c).ProviderPath
    # p was last updated at 2026-01-01T00:00:00Z = 1767225600; q has no entry left.
    @{ version = 2; plugins = @{ 'p@mkt' = @(@{ scope = 'user'; installPath = (Join-Path $c 'p/1.1'); version = '1.1'; installedAt = '2025-06-01T00:00:00.000Z'; lastUpdated = '2026-01-01T00:00:00.000Z' }) } } | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $cfg 'plugins/installed_plugins.json')
    $pbusy = Invoke-Shell 'Start-Sleep 120' (Join-Path $c 'p/0.9')
    $pargv = Invoke-Shell "Start-Sleep 120 # $(Join-Path $c 'p/0.8/hooks/run.mjs')"
    Start-Sleep 2
    $env:CLAUDE_CONFIG_DIR = $cfg
    function Invoke-PluginSweep([string]$Starts) { $env:SWEEP_SESSION_STARTS = $Starts; @(& $shell -NoProfile -File $sweep --plugins @args) }
    function Get-Removable($Out) { (@($Out | Where-Object { $_ -like 'would remove*' }) | ForEach-Object { ($_ -replace '\\', '/').Replace(($c -replace '\\', '/') + '/', '') } | Sort-Object) -join ';' }
    $out = Invoke-PluginSweep ''
    Test-Equal -Name 'plugin sweep lists only versions neither installed nor in use' -Got (Get-Removable $out) -Want 'would remove p/1.0;would remove q/2.0'
    Test-Equal -Name 'plugin sweep keeps the installed, busy and running versions' -Got @($out | Where-Object { $_ -match 'p.1\.1: installed|p.0\.9: in use|p.0\.8: named by a running command' }).Count -Want 3
    $out = Invoke-PluginSweep '1767225500'
    Test-Equal -Name 'a session started before the update keeps the old versions' -Got "$(Get-Removable $out)$(@($out | Where-Object { $_ -match '(p.1\.0|q.2\.0): 1 sessions started before the update' }).Count)" -Want '2'
    Test-Equal -Name 'a session started after the update keeps only a plugin with no entry' -Got (Get-Removable (Invoke-PluginSweep '1767225700')) -Want 'would remove p/1.0'
    Test-Equal -Name '--after-reload drops the session keep' -Got (Get-Removable (Invoke-PluginSweep '1767225500' --after-reload)) -Want 'would remove p/1.0;would remove q/2.0'
    Invoke-PluginSweep '1767225500' --apply | Out-Null
    Test-Equal -Name '--apply leaves what a session may still run' -Got @(Get-ChildItem $c -Recurse -Depth 1 -Directory).Count -Want 7
    Invoke-PluginSweep '' --apply | Out-Null
    Test-Equal -Name 'plugin --apply removes them and the emptied plugin dir' -Got ((Get-ChildItem $c -Recurse -Depth 1 -Directory | ForEach-Object { $_.Name } | Sort-Object) -join ' ') -Want '0.8 0.9 1.1 p'
    Set-Content (Join-Path $cfg 'plugins/installed_plugins.json') '{'
    Invoke-PluginSweep '' --apply 2>$null | Out-Null
    Test-Equal -Name 'unreadable installed_plugins.json removes nothing' -Got "$LASTEXITCODE $(@(Get-ChildItem (Join-Path $c 'p')).Count)" -Want '1 3'
    Remove-Item Env:SWEEP_SESSION_STARTS
    # The real process scan: sessions started by a `claude` binary (also under a path with a space), a versioned
    # binary and an npm install all count.
    $cfg2 = Join-Path $tmp 'claude2'
    $c2 = Join-Path $cfg2 'plugins/cache/mkt'
    foreach ($v in 'r/1.0', 'r/2.0') { New-Item -ItemType Directory -Force (Join-Path $c2 $v) | Out-Null }
    $c2 = (Resolve-Path $c2).ProviderPath
    $precious = Join-Path $tmp 'precious'
    New-Item -ItemType Directory -Force $precious | Out-Null
    Set-Content (Join-Path $precious 'file') keep
    New-Item -ItemType SymbolicLink -Path (Join-Path $c2 'r/0.5') -Target $precious | Out-Null
    @{ version = 2; plugins = @{ 'r@mkt' = @(@{ scope = 'user'; installPath = (Join-Path $c2 'r/2.0'); version = '2.0'; lastUpdated = '2099-01-01T00:00:00.000Z' }) } } | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $cfg2 'plugins/installed_plugins.json')
    $env:CLAUDE_CONFIG_DIR = $cfg2
    function Get-SessionCount {
        $m = @(& $shell -NoProfile -File $sweep --plugins | Where-Object { $_ -match 'r.1\.0: (\d+) sessions started before the update' } | ForEach-Object { [int]$Matches[1] })
        if ($m.Count) { $m[0] } else { 0 }
    }
    if ($env:OS -ne 'Windows_NT') {
        $sleep = (Get-Command sleep -CommandType Application | Select-Object -First 1).Source
        foreach ($d in 'fake/bin', 'fake/claude/versions', 'fake/Application Support') { New-Item -ItemType Directory -Force (Join-Path $tmp $d) | Out-Null }
        New-Item -ItemType SymbolicLink -Path (Join-Path $tmp 'fake/Application Support/claude') -Target $sleep | Out-Null
        New-Item -ItemType SymbolicLink -Path (Join-Path $tmp 'fake/bin/claude') -Target $sleep | Out-Null
        New-Item -ItemType SymbolicLink -Path (Join-Path $tmp 'fake/claude/versions/9.9.9') -Target $sleep | Out-Null
        $fakes = @(
            Start-Process (Join-Path $tmp 'fake/bin/claude') -ArgumentList 60 -PassThru
            Start-Process (Join-Path $tmp 'fake/claude/versions/9.9.9') -ArgumentList 60 -PassThru
            Start-Process (Join-Path $tmp 'fake/Application Support/claude') -ArgumentList 60 -PassThru
            Start-Process sh -ArgumentList "-c `"sleep 60; :`" $(Join-Path $tmp 'fake/node_modules/@anthropic-ai/claude-code/cli.js')" -PassThru
        )
        Start-Sleep 1
        $n1 = Get-SessionCount
        $fakes | Stop-Process -ErrorAction SilentlyContinue
        Start-Sleep 1
        $n0 = Get-SessionCount
        Test-Equal -Name 'the process scan finds sessions by binary, path with a space, versioned path and npm install' -Got ($n1 - $n0) -Want 4
        $badps = Join-Path $tmp 'badps'
        New-Item -ItemType Directory -Force $badps | Out-Null
        Set-Content (Join-Path $badps 'ps') "#!/bin/sh`nexit 1"
        chmod +x (Join-Path $badps 'ps')
        $savedPath = $env:PATH
        $env:PATH = "${badps}$([IO.Path]::PathSeparator)$savedPath"
        & $shell -NoProfile -File $sweep --plugins --apply 2>$null | Out-Null
        $code = $LASTEXITCODE
        $env:PATH = $savedPath
        Test-Equal -Name 'a failing ps removes nothing' -Got "$code $(Test-Path (Join-Path $c2 'r/1.0'))" -Want '1 True'
    }
    foreach ($d in 'outside/a/b', 'outside2/1.0') { New-Item -ItemType Directory -Force (Join-Path $tmp $d) | Out-Null }
    New-Item -ItemType SymbolicLink -Path (Join-Path $cfg2 'plugins/cache/linked') -Target (Join-Path $tmp 'outside') | Out-Null
    New-Item -ItemType SymbolicLink -Path (Join-Path $c2 'linkedp') -Target (Join-Path $tmp 'outside2') | Out-Null
    $env:SWEEP_SESSION_STARTS = ''
    $out = @(& $shell -NoProfile -File $sweep --plugins --after-reload --apply)
    Remove-Item Env:SWEEP_SESSION_STARTS
    Test-Equal -Name 'a linked marketplace or plugin dir is kept whole' -Got "$(@($out | Where-Object { $_ -match 'cache.linked: a link|mkt.linkedp: a link' }).Count) $(Test-Path (Join-Path $tmp 'outside/a/b')) $(Test-Path (Join-Path $tmp 'outside2/1.0'))" -Want '2 True True'
    Test-Equal -Name 'a symlinked version loses its link, never its target' -Got "$(Test-Path (Join-Path $c2 'r/0.5'))$(Get-Content (Join-Path $precious 'file'))" -Want 'Falsekeep'
    # --marketplace sweeps one marketplace and leaves the others (third-party plugins) alone.
    $cfg3 = Join-Path $tmp 'claude3'
    $c3 = Join-Path $cfg3 'plugins/cache'
    foreach ($v in 'mine/a/1.0', 'mine/a/2.0', 'other/b/1.0') { New-Item -ItemType Directory -Force (Join-Path $c3 $v) | Out-Null }
    $c3 = (Resolve-Path $c3).ProviderPath
    @{ version = 2; plugins = @{ 'a@mine' = @(@{ scope = 'user'; installPath = (Join-Path $c3 'mine/a/2.0'); version = '2.0'; lastUpdated = '2026-01-01T00:00:00.000Z' }) } } | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $cfg3 'plugins/installed_plugins.json')
    $env:CLAUDE_CONFIG_DIR = $cfg3
    $env:SWEEP_SESSION_STARTS = ''
    function Invoke-MktSweep { @(& $shell -NoProfile -File $sweep --plugins @args) }
    function Get-Rel($Out) { (@($Out | Where-Object { $_ -like 'would remove*' }) | ForEach-Object { ($_ -replace '\\', '/').Replace(($c3 -replace '\\', '/') + '/', '') } | Sort-Object) -join ';' }
    Test-Equal -Name "--marketplace lists only that marketplace's versions" -Got (Get-Rel (Invoke-MktSweep --marketplace mine)) -Want 'would remove mine/a/1.0'
    & $shell -NoProfile -File $sweep --plugins --marketplace mine --apply | Out-Null
    Test-Equal -Name '--marketplace --apply leaves a third-party version untouched' -Got "$(Test-Path (Join-Path $c3 'mine/a/1.0')) $(Test-Path (Join-Path $c3 'mine/a/2.0')) $(Test-Path (Join-Path $c3 'other/b/1.0'))" -Want 'False True True'
    Test-Equal -Name 'without --marketplace every marketplace is swept' -Got (Get-Rel (Invoke-MktSweep)) -Want 'would remove other/b/1.0'
    $out = @(& $shell -NoProfile -File $sweep --plugins --marketplace none --apply)
    Test-Equal -Name 'an unknown marketplace removes nothing' -Got "$LASTEXITCODE $($out -join '') $(Test-Path (Join-Path $c3 'other/b/1.0'))" -Want "0 sweep: no marketplace none in $c3 True"
    $codes = foreach ($bad in '', '.', '..', '../other', 'a/b', '--apply') { & $shell -NoProfile -File $sweep --plugins --marketplace $bad 2>$null | Out-Null; $LASTEXITCODE }
    & $shell -NoProfile -File $sweep --plugins --marketplace 2>$null | Out-Null; $codes += $LASTEXITCODE
    & $shell -NoProfile -File $sweep --marketplace mine 2>$null | Out-Null; $codes += $LASTEXITCODE
    Test-Equal -Name 'an empty, path-like, option-like or missing marketplace, or one without --plugins, is a usage error' -Got ($codes -join '') -Want '22222222'
    Remove-Item Env:SWEEP_SESSION_STARTS
    Remove-Item Env:CLAUDE_CONFIG_DIR
    Stop-Process -Id $pbusy.Id, $pargv.Id -ErrorAction SilentlyContinue
} finally {
    Remove-Item -Recurse -Force $tmp
}
exit $script:fails
