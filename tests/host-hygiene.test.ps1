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
    Remove-Item Env:CLAUDE_CONFIG_DIR
    Stop-Process -Id $pbusy.Id, $pargv.Id -ErrorAction SilentlyContinue
} finally {
    Remove-Item -Recurse -Force $tmp
}
exit $script:fails
