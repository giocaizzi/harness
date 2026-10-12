# Tests for plugins/dev-tools/skills/host-hygiene/scripts/heavy.ps1 (run by `make test` when pwsh is on PATH).
$ErrorActionPreference = 'Stop'
$heavy = Join-Path $PSScriptRoot '../plugins/dev-tools/skills/host-hygiene/scripts/heavy.ps1'
$tmp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid())
$env:HEAVY_STATE_DIR = Join-Path $tmp 'state'
$env:HEAVY_DISK_MIN_GB = '0'
$shell = (Get-Process -Id $PID).Path
$script:fails = 0
function Test-Equal([string]$Name, $Got, $Want) {
    if ("$Got" -eq "$Want") { "ok - $Name" } else { "not ok - ${Name}: got '$Got', want '$Want'"; $script:fails++ }
}
New-Item -ItemType Directory -Path $tmp | Out-Null
$log = Join-Path $tmp 'log'
try {
    # Two concurrent runs serialize: the second starts only after the first ends.
    $slow = "Add-Content '$log' start; Start-Sleep 2; Add-Content '$log' end"
    $fast = "Add-Content '$log' start; Add-Content '$log' end"
    $a = Start-Process $shell -ArgumentList '-NoProfile', '-File', $heavy, $shell, '-NoProfile', '-Command', $slow -PassThru
    Start-Sleep -Milliseconds 1000
    $b = Start-Process $shell -ArgumentList '-NoProfile', '-File', $heavy, $shell, '-NoProfile', '-Command', $fast -PassThru
    $a, $b | Wait-Process
    Test-Equal -Name 'concurrent runs serialize' -Got ((Get-Content $log) -join ' ') -Want 'start end start end'

    & $shell -NoProfile -File $heavy $shell -NoProfile -Command 'exit 7'
    Test-Equal -Name 'exit code propagates' -Got $LASTEXITCODE -Want 7

    # A holder that exits without releasing leaves an abandoned mutex; the next run takes it.
    $name = 'Global\heavy' + ($env:HEAVY_STATE_DIR -replace '[^A-Za-z0-9]', '_') + '-1'
    & $shell -NoProfile -Command "`$m = New-Object Threading.Mutex(`$false, '$name'); [void]`$m.WaitOne(); exit 0"
    & $shell -NoProfile -File $heavy $shell -NoProfile -Command 'exit 0' 2>$null
    Test-Equal -Name 'stale slot recovered' -Got $LASTEXITCODE -Want 0

    $env:HEAVY_DISK_MIN_GB = '999999999'
    & $shell -NoProfile -File $heavy $shell -NoProfile -Command "New-Item '$tmp/ran'" 2>$null
    Test-Equal -Name 'low disk refuses' -Got "$LASTEXITCODE $(Test-Path "$tmp/ran")" -Want '1 False'
} finally {
    Remove-Item -Recurse -Force $tmp
}
exit $script:fails
