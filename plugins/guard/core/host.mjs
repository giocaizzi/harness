// Host facts, the same on every OS: { load1?, cpuPercent?, freeGb? }.
// Unix reports the 1-minute load average; Windows has none, so it reports CPU percent.
// Parsers are pure (adapters run the probes), so they are tested without a host.

export const UNIX_PROBES = { load: ['uptime'], disk: ['df', '-k', '/'] }

// Windows: one PowerShell call printing "<cpu percent> <free bytes of the system drive>".
export const WINDOWS_PROBE = [
  'powershell',
  '-NoProfile',
  '-Command',
  '$c=(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average; ' +
    '$f=(Get-PSDrive -Name ($env:SystemDrive.TrimEnd(":"))).Free; "$c $f"',
]

export function parseLoad1(stdout) {
  const m = /load averages?:\s*([\d.]+)/.exec(stdout ?? '')
  return m ? Number(m[1]) : undefined
}

// `df -k /` -> available GB (4th column of the last line)
export function parseDfFreeGb(stdout) {
  const kb = Number(String(stdout ?? '').trim().split('\n').pop().trim().split(/\s+/)[3])
  return Number.isFinite(kb) ? Math.round(kb / 1048576) : undefined
}

export function parseWindows(stdout) {
  const [cpu, free] = String(stdout ?? '').trim().split(/\s+/).map(Number)
  return {
    cpuPercent: Number.isFinite(cpu) ? cpu : undefined,
    freeGb: Number.isFinite(free) ? Math.round(free / 1073741824) : undefined,
  }
}

// CPU percent between two os.cpus() snapshots (used where no load average exists).
export function cpuPercentFrom(before, after) {
  const sum = (cpus) => cpus.reduce((t, c) => ({ idle: t.idle + c.times.idle, total: t.total + Object.values(c.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 })
  const a = sum(before)
  const b = sum(after)
  const total = b.total - a.total
  return total > 0 ? Math.round((100 * (total - (b.idle - a.idle))) / total) : undefined
}
