# land-many.ps1 [--interval <s>] [--timeout <s>] <pr>...   land several approved PRs at once, never one after another
#
# Every poll (one per interval) walks all PRs still open, in the repo `gh repo view` names ($env:GH_REPO selects
# another). A PR whose required checks (the base branch's rules, never a hardcoded name) passed on its current
# head is enqueued with the enqueuePullRequest mutation when its base has a merge queue, or gets
# `gh pr merge --auto --squash` once when it has none; a PR that falls out of the queue is enqueued again, up to
# LAND_MANY_REQUEUES (2) times. Nothing is bypassed. One line per PR, as soon as it ends:
#   PR <n>: MERGED <sha> | CLOSED | DIRTY | BEHIND | FAILED <why> | ERROR <gh error> | TIMEOUT <state>
# DIRTY is a conflict; BEHIND (only without a queue) needs the base merged in; ERROR is gh failing 3 polls in a row.
# Exits 0 when every PR merged, 1 otherwise, 2 on usage. Needs gh.
# --interval (1-3600) and --timeout (1-86400) default to LAND_MANY_INTERVAL (30) and LAND_MANY_TIMEOUT (7200) seconds.
$ErrorActionPreference = 'Stop'
function Exit-Usage { [Console]::Error.WriteLine('usage: land-many.ps1 [--interval <1-3600 s>] [--timeout <1-86400 s>] <pr>...'); exit 2 }
function Get-Duration([string]$Value, [int]$Max) {
    if ($Value -cnotmatch '^[1-9][0-9]{0,4}\z' -or [int]$Value -gt $Max) { Exit-Usage }
    [int]$Value
}
$interval = if ($env:LAND_MANY_INTERVAL) { $env:LAND_MANY_INTERVAL } else { '30' }
$timeout = if ($env:LAND_MANY_TIMEOUT) { $env:LAND_MANY_TIMEOUT } else { '7200' }
$requeuesText = if ($env:LAND_MANY_REQUEUES) { $env:LAND_MANY_REQUEUES } else { '2' }
$prs = @()
$argv = @($args)
for ($i = 0; $i -lt $argv.Count; $i++) {
    $a = "$($argv[$i])"
    if ($a -eq '--interval' -or $a -eq '--timeout') {
        if ($i + 1 -ge $argv.Count) { Exit-Usage }
        $i++
        if ($a -eq '--interval') { $interval = "$($argv[$i])" } else { $timeout = "$($argv[$i])" }
    } elseif ($a -cmatch '^[1-9][0-9]*\z') { $prs += $a }
    else { Exit-Usage }
}
if ($prs.Count -eq 0) { Exit-Usage }
$interval = Get-Duration $interval 3600
$timeout = Get-Duration $timeout 86400
if ($requeuesText -cnotmatch '^[0-9]\z') { Exit-Usage }
$requeues = [int]$requeuesText

$errFile = [IO.Path]::GetTempFileName()
# Invoke-Gh <args>: gh's stdout as one string, $null when it failed (its stderr in $errFile).
function Invoke-Gh([string[]]$GhArgs) {
    $out = & gh @GhArgs 2>$errFile
    if ($LASTEXITCODE -ne 0) { return $null }
    ($out -join "`n")
}
function Get-Err { $e = @(Get-Content $errFile -ErrorAction SilentlyContinue); if ($e.Count) { $e[0] } else { 'unknown error' } }
$repo = Invoke-Gh @('repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner')
if (-not $repo) { [Console]::Error.WriteLine('land-many: gh repo view failed'); exit 1 }
$owner, $name = $repo.Trim() -split '/', 2
$query = 'query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){' +
    'id state mergeStateStatus headRefOid baseRefName isInMergeQueue isMergeQueueEnabled mergeCommit{oid} ' +
    'statusCheckRollup{contexts(first:100){nodes{__typename ' +
    '... on CheckRun{name status conclusion detailsUrl} ... on StatusContext{context state targetUrl}}}}}}}'
$mutation = 'mutation($id:ID!,$head:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$head}){mergeQueueEntry{position}}}'
$requiredByBase = @{}
# The required check names on a branch, from its rules; $null when gh failed.
function Get-Required([string]$Base) {
    if (-not $requiredByBase.ContainsKey($Base)) {
        $r = Invoke-Gh @('api', "repos/$repo/rules/branches/$Base")
        if ($null -eq $r) { return $null }
        $names = @(ConvertFrom-Json -InputObject $r | Where-Object { $_.type -eq 'required_status_checks' } |
            ForEach-Object { $_.parameters.required_status_checks } | ForEach-Object { $_.context } | Sort-Object -Unique)
        $requiredByBase[$Base] = $names
    }
    , $requiredByBase[$Base]
}
# Each rollup entry as name, bucket (pass, pending, fail) and link.
function Get-Rollup($Pr) {
    foreach ($c in @($Pr.statusCheckRollup.contexts.nodes)) {
        if (-not $c) { continue }
        if ($c.__typename -eq 'CheckRun') {
            $s = if ($c.status -ne 'COMPLETED') { 'pending' } elseif ($c.conclusion -in 'SUCCESS', 'NEUTRAL', 'SKIPPED') { 'pass' } else { 'fail' }
            [pscustomobject]@{ name = $c.name; s = $s; link = "$($c.detailsUrl)" }
        } else {
            $s = if ($c.state -eq 'SUCCESS') { 'pass' } elseif ($c.state -in 'PENDING', 'EXPECTED') { 'pending' } else { 'fail' }
            [pscustomobject]@{ name = $c.context; s = $s; link = "$($c.targetUrl)" }
        }
    }
}

$n = $prs.Count
$left = $n; $status = 0
$done = @(0) * $n; $enq = @(0) * $n; $fails = @(0) * $n; $armed = @(0) * $n; $last = @('unknown') * $n
function Complete-Pr([int]$I, [string]$What) {
    "PR $($prs[$I]): $What"
    $script:done[$I] = 1; $script:left--
    if (-not $What.StartsWith('MERGED')) { $script:status = 1 }
}
function Add-Strike([int]$I) {
    $script:fails[$I]++
    if ($script:fails[$I] -ge 3) { Complete-Pr $I "ERROR $(Get-Err)" }
}
$deadline = [DateTime]::UtcNow.AddSeconds($timeout)
try {
    while ($true) {
        for ($i = 0; $i -lt $n; $i++) {
            if ($done[$i]) { continue }
            $pr = $prs[$i]
            $raw = Invoke-Gh @('api', 'graphql', '-f', "query=$query", '-f', "owner=$owner", '-f', "name=$name", '-F', "n=$pr")
            $p = $null
            if ($null -ne $raw) { try { $p = (ConvertFrom-Json -InputObject $raw).data.repository.pullRequest } catch { $p = $null } }
            if (-not $p) { Add-Strike $i; continue }
            $last[$i] = "$($p.state) $($p.mergeStateStatus)"
            if ($p.state -eq 'MERGED') { Complete-Pr $i "MERGED $($p.mergeCommit.oid)"; continue }
            if ($p.state -eq 'CLOSED') { Complete-Pr $i 'CLOSED'; continue }
            if ($p.mergeStateStatus -eq 'DIRTY') { Complete-Pr $i 'DIRTY'; continue }
            if ($p.mergeStateStatus -eq 'BEHIND' -and -not $p.isMergeQueueEnabled) { Complete-Pr $i 'BEHIND'; continue }
            $req = Get-Required $p.baseRefName
            if ($null -eq $req) { Add-Strike $i; continue }
            $rollup = @(Get-Rollup $p)
            $failed = @(); $pending = @()
            foreach ($r in $req) {
                $c = @($rollup | Where-Object { $_.name -eq $r })
                $bad = @($c | Where-Object { $_.s -eq 'fail' })
                if ($bad.Count) { $failed += "$r $($bad[0].link)" }
                elseif ($c.Count -eq 0 -or @($c | Where-Object { $_.s -eq 'pending' }).Count) { $pending += $r }
            }
            if ($failed.Count) { Complete-Pr $i "FAILED required check $($failed -join ', ')"; continue }
            if ($pending.Count) { $last[$i] = "$($p.state) $($p.mergeStateStatus), pending: $($pending -join ',')"; $fails[$i] = 0; continue }
            if ($p.isMergeQueueEnabled) {
                if ($p.isInMergeQueue) { $fails[$i] = 0; continue }
                if ($enq[$i] -gt $requeues) { Complete-Pr $i "FAILED left the merge queue $($enq[$i]) times (read its merge_group run)"; continue }
                if ($null -eq (Invoke-Gh @('api', 'graphql', '-f', "query=$mutation", '-f', "id=$($p.id)", '-f', "head=$($p.headRefOid)"))) { Add-Strike $i; continue }
                $enq[$i]++; $last[$i] = "$($p.state) $($p.mergeStateStatus), queued"
            } elseif (-not $armed[$i]) {
                if ($null -eq (Invoke-Gh @('pr', 'merge', $pr, '--auto', '--squash', '--match-head-commit', $p.headRefOid))) { Add-Strike $i; continue }
                $armed[$i] = 1; $last[$i] = "$($p.state) $($p.mergeStateStatus), auto-merge armed"
            }
            $fails[$i] = 0
        }
        if ($left -le 0) { exit $status }
        $waitLeft = [int][Math]::Ceiling(($deadline - [DateTime]::UtcNow).TotalSeconds)
        if ($waitLeft -le 0) {
            for ($i = 0; $i -lt $n; $i++) { if (-not $done[$i]) { Complete-Pr $i "TIMEOUT after ${timeout}s, $($last[$i])" } }
            exit $status
        }
        Start-Sleep -Seconds ([Math]::Min($interval, $waitLeft))
    }
} finally {
    Remove-Item -Force -ErrorAction SilentlyContinue $errFile
}
