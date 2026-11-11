# sweep-stale.ps1 --plugins [--marketplace <name>] [--after-reload] [--apply]   list (default) or remove stale Claude Code plugin cache versions
#
# The git sweep (worktrees, branches, stashes) moved to repo-sweep.mjs; any call without --plugins prints a
# pointer to it and exits 2.
#
# --plugins sweeps the Claude Code plugin cache: version dirs under
# $env:CLAUDE_CONFIG_DIR (default ~/.claude)/plugins/cache/<marketplace>/<plugin>/<version> that are
# not the installPath of any entry in plugins/installed_plugins.json (any scope) and that nothing may
# still run. A running session loaded its plugins at start and spawns hooks from that path later
# without holding it open, so a version is kept while any Claude Code process (found by its command line) started before the
# plugin's newest lastUpdated (or while any runs, for a plugin with no entry left), besides the busy
# check below and a process command line naming it. /reload-plugins does not restart the process,
# so only the user can tell the sweep that every session reloaded: --after-reload drops that keep.
# Session start times come from ps (Win32_Process on Windows), or SWEEP_SESSION_STARTS (epoch seconds, one per line)
# when set. An unreadable installed_plugins.json or process list removes nothing. A linked marketplace or
# plugin dir is kept whole; a linked version dir loses only its link. --apply removes them.
# --marketplace <name> sweeps only cache/<name>, leaving every other marketplace's versions alone. The name
# must equal a cache dir's name exactly (case included): it is matched against the listing, never resolved as a
# path, so neither a case-insensitive filesystem nor Win32's trailing dot and space trimming can hand back a dir
# under a spelling the installed check misses (or the cache itself).
# Busy check: on Windows, renaming a version dir fails while any process has a file or its cwd
# in it, so the sweep renames it and back; elsewhere it asks lsof.
$ErrorActionPreference = 'Continue' # native stderr must not throw (Windows PowerShell 5.1)
$marketplace = $null
$flags = @(for ($i = 0; $i -lt $args.Count; $i++) {
    if ($args[$i] -ne '--marketplace') { $args[$i]; continue }
    # One dir name under the cache: an empty, path-like or option-like name is a usage error, never "all of them".
    $marketplace = if ($i + 1 -lt $args.Count) { [string]$args[++$i] } else { '' }
    if ($marketplace -match '^[. ]*$|^-|[\\/]') { '--bad-marketplace' }
})
$apply = $flags -contains '--apply'
$plugins = $flags -contains '--plugins'
$afterReload = $flags -contains '--after-reload'
if (-not $plugins) { [Console]::Error.WriteLine('sweep-stale: the git sweep moved to repo-sweep.mjs (node repo-sweep.mjs [--apply])'); exit 2 }
$unknown = @($flags | Where-Object { $_ -notin '--apply', '--plugins', '--after-reload' })
if ($unknown.Count) { [Console]::Error.WriteLine('usage: sweep-stale.ps1 --plugins [--marketplace <name>] [--after-reload] [--apply]'); exit 2 }
$onWindows = $IsWindows -or $PSVersionTable.PSEdition -eq 'Desktop'
if (-not $onWindows -and -not (Get-Command lsof -ErrorAction SilentlyContinue)) {
    [Console]::Error.WriteLine('sweep: lsof not found; cannot tell busy versions, nothing removed'); exit 1
}
function Get-FullPath([string]$Path) { [IO.Path]::GetFullPath($Path).TrimEnd('\', '/') }

function Test-Busy([string]$Path) {
    if ($onWindows) {
        $probe = "$Path.sweep-probe"
        try { Rename-Item -LiteralPath $Path -NewName (Split-Path -Leaf $probe) -ErrorAction Stop } catch { return $true }
        try { Rename-Item -LiteralPath $probe -NewName (Split-Path -Leaf $Path) -ErrorAction Stop }
        catch { [Console]::Error.WriteLine("sweep: could not rename $probe back to $Path; rename it by hand"); return $true }
        return $false
    }
    # lsof exits 1 for "nothing found" and also on harmless warnings: judge by output past the header.
    @(lsof +D $Path 2>$null | Select-Object -Skip 1).Count -gt 0
}

if ($plugins) {
    $base = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
    $root = Join-Path $base 'plugins'
    $cache = Join-Path $root 'cache'
    if (-not (Test-Path -LiteralPath $cache)) { "sweep: no plugin cache at $cache"; exit 0 }
    if ($marketplace) {
        $mkts = @(Get-ChildItem -LiteralPath $cache -Directory | Where-Object { $_.Name -ceq $marketplace })
        if ($mkts.Count -ne 1) { "sweep: no marketplace $marketplace in $cache"; exit 0 }
    } else { $mkts = @(Get-ChildItem -LiteralPath $cache -Directory) }
    try { $doc = Get-Content -Raw -LiteralPath (Join-Path $root 'installed_plugins.json') -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop }
    catch { $doc = $null }
    if ($null -eq $doc -or $null -eq $doc.plugins) { [Console]::Error.WriteLine("sweep: cannot read $root/installed_plugins.json; nothing removed"); exit 1 }
    # Resolve both sides: the recorded installPath may go through a symlink (/tmp, a moved home).
    function Resolve-Real([string]$Path) { Get-FullPath ((Resolve-Path -LiteralPath $Path).ProviderPath) }
    $installed = @(foreach ($p in $doc.plugins.PSObject.Properties) {
        foreach ($e in @($p.Value)) { if ($e.installPath -and (Test-Path -LiteralPath $e.installPath)) { Resolve-Real $e.installPath } }
    })
    # Plugin key (<plugin>@<marketplace>) -> the newest lastUpdated (or installedAt) of its entries, as epoch seconds.
    function ConvertTo-Epoch($v) {
        if ($v -is [datetime]) { return ([DateTimeOffset]$v).ToUnixTimeSeconds() }
        [DateTimeOffset]::Parse([string]$v, [Globalization.CultureInfo]::InvariantCulture).ToUnixTimeSeconds()
    }
    $updated = @{}
    foreach ($p in $doc.plugins.PSObject.Properties) {
        $times = @(foreach ($e in @($p.Value)) { $t = if ($e.lastUpdated) { $e.lastUpdated } else { $e.installedAt }; if ($t) { ConvertTo-Epoch $t } })
        if ($times.Count) { $updated[$p.Name] = ($times | Measure-Object -Maximum).Maximum }
    }
    # A session is any process whose command line is Claude Code: a `claude` executable, a versioned binary under
    # .../claude/versions/, or an npm install run by node. Doubt keeps the version: an unreadable start time counts
    # as 0 (before every update), and on Windows a node process whose command line cannot be read counts too.
    # Throws when the process list cannot be read, which stops the sweep instead of reading as "no sessions".
    function Get-SessionStart {
        if ($onWindows) {
            foreach ($p in @(Get-CimInstance Win32_Process -ErrorAction Stop)) {
                $exe = "$($p.ExecutablePath)"; $cmd = "$($p.CommandLine)"
                $hit = $p.Name -eq 'claude.exe' -or $exe -match '[\\/]claude[\\/]versions[\\/]' -or $cmd -match '@anthropic-ai[\\/]claude-code' -or ($p.Name -eq 'node.exe' -and -not $cmd)
                if ($hit) { if ($p.CreationDate) { ([DateTimeOffset]$p.CreationDate).ToUnixTimeSeconds() } else { 0 } }
            }
            return
        }
        $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
        $table = @(ps -axo etime=,command= 2>$null)
        if ($LASTEXITCODE) { throw 'ps failed' }
        foreach ($line in $table) {
            $f = -split $line
            if ($f.Count -lt 2) { continue }
            # The whole command line, since argv[0] may hold spaces; a false match only keeps a version longer.
            $c = $line.Substring($line.IndexOf($f[0]) + $f[0].Length)
            if (-not ($c -match '(^|[ /])claude( |$)' -or $c -match '/claude/versions/' -or $c -match '@anthropic-ai/claude-code')) { continue }
            if ($f[0] -notmatch '^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$') { 0; continue }
            $now - ([long]$Matches[1] * 86400 + [long]$Matches[2] * 3600 + [long]$Matches[3] * 60 + [long]$Matches[4])
        }
    }
    if (-not $onWindows -and -not (Get-Command ps -CommandType Application -ErrorAction SilentlyContinue)) {
        [Console]::Error.WriteLine('sweep: ps not found; cannot tell running sessions, nothing removed'); exit 1
    }
    try {
        $starts = if ($null -ne $env:SWEEP_SESSION_STARTS) { @($env:SWEEP_SESSION_STARTS -split "`r?`n" | Where-Object { $_ } | ForEach-Object { [long]$_ }) } else { @(Get-SessionStart) }
        $procs = if ($onWindows) { @(Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { $_.CommandLine }) }
            else { $out = @(ps -axo command= 2>$null); if ($LASTEXITCODE) { throw 'ps failed' }; $out }
    } catch { [Console]::Error.WriteLine('sweep: cannot read the process list; cannot tell running sessions, nothing removed'); exit 1 }
    $sep = [IO.Path]::DirectorySeparatorChar
    # Never descend through a link: a linked marketplace or plugin dir is kept whole, since its grandchildren live
    # outside the cache.
    $versions = foreach ($m in $mkts) {
        if ($m.LinkType) { Write-Output "keep $(Get-FullPath $m.FullName): a link; the sweep never follows links above a version"; continue }
        foreach ($p in @(Get-ChildItem -LiteralPath $m.FullName -Directory)) {
            if ($p.LinkType) { Write-Output "keep $(Get-FullPath $p.FullName): a link; the sweep never follows links above a version"; continue }
            Get-ChildItem -LiteralPath $p.FullName -Directory
        }
    }
    foreach ($dir in @($versions)) {
        if ($dir -is [string]) { $dir; continue }
        # $entry is the cache path, which is what gets removed: a symlinked version dir loses its link, never its
        # target. $real is only for comparing and probing.
        $entry = Get-FullPath $dir.FullName
        $real = if ($dir.LinkType) { Get-FullPath ([IO.Path]::Combine((Split-Path -Parent $entry), [string]@($dir.Target)[0])) } else { $entry }
        # -contains ignores case, as Windows paths do; elsewhere that only errs toward keeping.
        if ($installed -contains (Resolve-Real $entry) -or $installed -contains $real) { "keep ${entry}: installed"; continue }
        if (-not $afterReload) {
            $key = "$($dir.Parent.Name)@$($dir.Parent.Parent.Name)"
            $n = @($starts | Where-Object { -not $updated.ContainsKey($key) -or $_ -lt $updated[$key] }).Count
            if ($n) { "keep ${entry}: $n sessions started before the update; reload them first, then --after-reload"; continue }
        }
        if (@($procs | Where-Object { $_ -and ($_.Contains("$entry$sep") -or $_.Contains("$real$sep")) }).Count) { "keep ${entry}: named by a running command"; continue }
        # A link holds no files, and removing it leaves its target and any handle open in it alone. On Windows the
        # rename probe would rename the target, outside the cache, so a link skips it there; the session keep and
        # the command-line check above still apply.
        if (-not ($dir.LinkType -and $onWindows) -and (Test-Busy $real)) { "keep ${entry}: in use by a process"; continue }
        if ($apply) {
            if ($dir.LinkType) { [IO.Directory]::Delete($entry) } else { Remove-Item -LiteralPath $entry -Recurse -Force }
            if ($?) { "removed $entry" }
            $parent = Split-Path -Parent $entry
            if (-not @(Get-ChildItem -LiteralPath $parent -Force).Count) { Remove-Item -LiteralPath $parent }
        } else { "would remove $entry" }
    }
    exit 0
}
