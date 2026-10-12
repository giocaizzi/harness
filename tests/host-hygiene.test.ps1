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
$mutex1 = 'Global\host-heavy' + ($L -replace '[^A-Za-z0-9]', '_') + '-1'
$script:fails = 0
function Test-Equal([string]$Name, $Got, $Want) {
    if ("$Got" -eq "$Want") { "ok - $Name" } else { "not ok - ${Name}: got '$Got', want '$Want'"; $script:fails++ }
}
function Invoke-Shell([string]$Command, [string]$Dir = $tmp) {
    Start-Process $shell -ArgumentList '-NoProfile', '-Command', $Command -WorkingDirectory $Dir -PassThru
}
function Get-DeadPid { $p = Invoke-Shell 'exit 0'; $p.WaitForExit(); $p.Id }
function Invoke-SlotHolder { $h = Invoke-Shell "`$m = New-Object Threading.Mutex(`$false, '$mutex1'); [void]`$m.WaitOne(); Start-Sleep 8"; Start-Sleep 2; $h }
New-Item -ItemType Directory -Path $tmp | Out-Null
$log = Join-Path $tmp 'log'
try {
    # heavy.ps1
    $slow = "Add-Content '$log' start; Start-Sleep 2; Add-Content '$log' end"
    $fast = "Add-Content '$log' start; Add-Content '$log' end"
    $a = Start-Process $shell -ArgumentList '-NoProfile', '-File', $heavy, $shell, '-NoProfile', '-Command', $slow -PassThru
    Start-Sleep -Milliseconds 1000
    $b = Start-Process $shell -ArgumentList '-NoProfile', '-File', $heavy, $shell, '-NoProfile', '-Command', $fast -PassThru
    $a, $b | Wait-Process
    Test-Equal -Name 'one slot: concurrent runs serialize' -Got ((Get-Content $log) -join ' ') -Want 'start end start end'

    Remove-Item $log
    $env:HOST_HEAVY_SLOTS = '2'
    $a = Start-Process $shell -ArgumentList '-NoProfile', '-File', $heavy, $shell, '-NoProfile', '-Command', $slow -PassThru
    Start-Sleep -Milliseconds 1000
    $b = Start-Process $shell -ArgumentList '-NoProfile', '-File', $heavy, $shell, '-NoProfile', '-Command', $fast -PassThru
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
    $w = Start-Process $shell -ArgumentList '-NoProfile', '-File', $reg, 'db', '--', $shell, '-NoProfile', '-Command', 'Start-Sleep 3' -PassThru
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
} finally {
    Remove-Item -Recurse -Force $tmp
}
exit $script:fails
