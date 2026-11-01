// Host facts, the same on every OS: { load1?, cpuPercent?, freeGb? }.
// Unix reports the 1-minute load average; Windows has none, so it reports CPU percent.
// Parsers are pure (adapters run the probes), so they are tested without a host.
import { UNIX_PROBES, WINDOWS_PROBE } from "./constants.mjs";
export { UNIX_PROBES, WINDOWS_PROBE };
/** Parse the 1-minute load average from `uptime` output. */
export function parseLoad1(stdout) {
    const m = /load averages?:\s*([\d.]+)/.exec(stdout ?? "");
    return m ? Number(m[1]) : undefined;
}
/** Parse available gigabytes from `df -k /` output (4th column of the last line). */
export function parseDfFreeGb(stdout) {
    const lastLine = (stdout ?? "").trim().split("\n").pop() ?? "";
    const kb = Number(lastLine.trim().split(/\s+/)[3]);
    return Number.isFinite(kb) ? Math.round(kb / 1048576) : undefined;
}
/** Parse CPU percentage and free gigabytes from the Windows PowerShell probe output. */
export function parseWindows(stdout) {
    const [cpu, free] = (stdout ?? "").trim().split(/\s+/).map(Number);
    return {
        cpuPercent: cpu !== undefined && Number.isFinite(cpu) ? cpu : undefined,
        freeGb: free !== undefined && Number.isFinite(free)
            ? Math.round(free / 1073741824)
            : undefined,
    };
}
/** Compute CPU percentage between two `os.cpus()` snapshots where no load average exists. */
export function cpuPercentFrom(before, after) {
    const sum = (cpus) => cpus.reduce((t, c) => ({
        idle: t.idle + c.times.idle,
        total: t.total +
            c.times.user +
            c.times.nice +
            c.times.sys +
            c.times.idle +
            c.times.irq,
    }), { idle: 0, total: 0 });
    const a = sum(before);
    const b = sum(after);
    const total = b.total - a.total;
    return total > 0
        ? Math.round((100 * (total - (b.idle - a.idle))) / total)
        : undefined;
}
