# attended.ps1 <owner>/<repo>#<number> [--] <harness command...>
#   Start an attended ticket-run session tagged like a runtime's runs: sets FACTORY_ATTENDED_RUN_ID
#   and FACTORY_ATTENDED_TICKET (ticket-run copies the id into result.json and its claim), and
#   appends factory.run_id, factory.ticket, factory.role=main and factory.mode=attended to
#   OTEL_RESOURCE_ATTRIBUTES and its GUARD_OTEL_RESOURCE_ATTRIBUTES copy, then runs the command.
#   Any factory.* pair already there is replaced (keys match case-sensitively, as OTel keys do); the other
#   pairs are kept, trimmed of surrounding whitespace. Example: attended.ps1 acme/app#12 claude
#   Windows PowerShell 5.1: powershell -ExecutionPolicy Bypass -File attended.ps1 ...
$ErrorActionPreference = 'Stop'

function Exit-Usage { [Console]::Error.WriteLine('usage: attended.ps1 <owner>/<repo>#<number> [--] <harness command...>'); exit 2 }
$argv = @($args)
if ($argv.Count -eq 0) { Exit-Usage }
$ticket = [string]$argv[0]; $argv = @($argv | Select-Object -Skip 1)
if ($argv.Count -gt 0 -and $argv[0] -eq '--') { $argv = @($argv | Select-Object -Skip 1) }
if ($argv.Count -eq 0) { Exit-Usage }
# Only these characters, so no value needs percent-encoding in the attribute list.
if ($ticket -cnotmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#([0-9]+)\z') { [Console]::Error.WriteLine("attended: '$ticket' is not <owner>/<repo>#<number>"); exit 2 }
$number = $Matches[1]
if ($env:FACTORY_RUN_ID) { [Console]::Error.WriteLine("attended: FACTORY_RUN_ID is set, so this is a runtime's run, not an attended one"); exit 2 }

$hostName = ([System.Net.Dns]::GetHostName() -split '\.')[0]
$runId = "$hostName-$number-" + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ', [cultureinfo]::InvariantCulture)
$tags = "factory.run_id=$runId,factory.ticket=$ticket,factory.role=main,factory.mode=attended"

# The pairs of $List without factory.*, then the run's tags.
function Add-Tag([string]$List) {
    $kept = @("$List" -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' -and $_ -cnotlike 'factory.*=*' })
    (@($kept) + $tags) -join ','
}

$env:FACTORY_ATTENDED_RUN_ID = $runId
$env:FACTORY_ATTENDED_TICKET = $ticket
$env:OTEL_RESOURCE_ATTRIBUTES = Add-Tag $env:OTEL_RESOURCE_ATTRIBUTES
$env:GUARD_OTEL_RESOURCE_ATTRIBUTES = Add-Tag $env:GUARD_OTEL_RESOURCE_ATTRIBUTES
[Console]::Error.WriteLine("attended: run $runId for $ticket")
$command = $argv[0]; $rest = @($argv | Select-Object -Skip 1)
& $command @rest
exit $LASTEXITCODE
