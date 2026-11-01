// SessionStart hook: keep the machine awake while the harness runs. One detached keeper per harness process,
// tied to its pid, so it ends with the session: macOS caffeinate -w, Linux systemd-inhibit around tail --pid,
// Windows SetThreadExecutionState held by a PowerShell that waits on the pid. No tool for it: skip.

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { pluginDataDir } from "./data.mjs";
import type { ProcessInfo, ProcessLookup } from "./types.mjs";

// The hook's parent is often the shell the harness ran `command` in: skip shells up to the harness itself.
const SHELL = /^-?(sh|bash|zsh|dash|ksh|fish|pwsh|powershell|cmd)(\.exe)?$/i;

export function harnessPid(
  start: number,
  lookup: (pid: number) => ProcessInfo | null,
): number {
  let pid = start;
  for (let i = 0; i < 4; i++) {
    const p = lookup(pid);
    if (!p || !SHELL.test(p.name) || !(p.ppid > 1)) return pid;
    pid = p.ppid;
  }
  return pid;
}

// { ppid, name } of a pid, or null.
export function lookupProcess(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): ProcessInfo | null {
  const opts = { encoding: "utf8" as const, timeout: 5000, windowsHide: true };
  const out =
    platform === "win32"
      ? spawnSync(
          "powershell",
          [
            "-NoProfile",
            "-Command",
            `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${String(pid)}"; if ($p) { "$($p.ParentProcessId) $($p.Name)" }`,
          ],
          opts,
        ).stdout
      : spawnSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], opts).stdout;
  const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(out);
  const ppidStr = m?.[1];
  const nameStr = m?.[2];
  if (!ppidStr || !nameStr) return null;
  const nameParts = nameStr.split(/[\\/]/);
  const lastName = nameParts[nameParts.length - 1] ?? nameStr;
  return { ppid: Number(ppidStr), name: lastName };
}

const WIN_KEEPER = (pid: number): string =>
  "Add-Type -Namespace Guard -Name Power -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);'; " +
  `[void][Guard.Power]::SetThreadExecutionState([uint32]2147483649); Wait-Process -Id ${String(pid)} -ErrorAction SilentlyContinue`;

export function keeperArgv(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): string[] | null {
  if (platform === "darwin") return ["caffeinate", "-i", "-w", String(pid)];
  if (platform === "linux")
    return [
      "systemd-inhibit",
      "--what=idle:sleep",
      "--who=guard",
      "--why=agent session",
      "--mode=block",
      "tail",
      `--pid=${String(pid)}`,
      "-f",
      "/dev/null",
    ];
  if (platform === "win32")
    return [
      "powershell",
      "-NoProfile",
      "-WindowStyle",
      "Hidden",
      "-EncodedCommand",
      Buffer.from(WIN_KEEPER(pid), "utf16le").toString("base64"),
    ];
  return null;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export interface KeepAwakeParams {
  dataDir: string;
  isAlive?: (pid: number) => boolean;
  launch: (argv: string[]) => number | null | undefined;
  lookup?: ProcessLookup;
  platform?: NodeJS.Platform;
  start?: number;
}

export interface KeepAwakeResult {
  argv: string[];
  harness: number;
  keeper: number;
}

// Start a keeper for this harness unless one recorded for it is still running (resume, /clear, compact).
export function keepAwake({
  dataDir,
  start = process.ppid,
  lookup = lookupProcess,
  platform = process.platform,
  launch,
  isAlive = alive,
}: KeepAwakeParams): KeepAwakeResult | null {
  const pid = harnessPid(start, (p) => lookup(p, platform));
  const argv = keeperArgv(pid, platform);
  if (!argv) return null;
  const file = join(dataDir, "awake", `${String(pid)}.pid`);
  let kept = 0;
  try {
    kept = Number(readFileSync(file, "utf8"));
  } catch {
    // first session start for this harness
  }
  if (kept && isAlive(kept)) return null;
  const keeper = launch(argv);
  if (!keeper) return null;
  mkdirSync(join(dataDir, "awake"), { recursive: true });
  writeFileSync(file, String(keeper));
  return { harness: pid, keeper, argv };
}

const launchDetached = (argv: string[]): number | undefined => {
  const exe = argv[0];
  if (!exe) return undefined;
  const child = spawn(exe, argv.slice(1), {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => {
    // tool missing: no keeper
  });
  child.unref();
  return child.pid;
};

const entryArg = process.argv[1];
if (entryArg && import.meta.url === pathToFileURL(entryArg).href) {
  try {
    const dataDir = pluginDataDir();
    keepAwake({ dataDir, launch: launchDetached });
  } catch {
    // never block a session start
  }
}
