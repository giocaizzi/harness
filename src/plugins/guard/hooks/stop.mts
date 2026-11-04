// Stop hook (Claude Code and VS Code Stop, Copilot agentStop): run `make check-fast` (when the Makefile
// defines it; large repos keep the full suite for CI) or else `make check` before the agent stops, but only
// when the repo changed since the last green run, and the change is not docs only (core/docsonly.mjs, plus the repo's
// `.stop-check-ignore`). On failure, block the stop once and hand back the output
// tail; a second stop (stop_hook_active) always passes, so it cannot loop. No make, no Makefile or neither
// target: nothing to do. make runs detached from the terminal (stdin closed, its own session), so a recipe that
// reads /dev/tty fails at once instead of hanging the session.

import { type SpawnSyncReturns, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { loadavg, platform } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";

import { docsOnly } from "../core/docsonly.mjs";
import { hostCaps } from "../core/host.mjs";
import { emit } from "../core/otel.mjs";
import { UNREGISTERED_RULE, resultFile } from "../core/registration.mjs";
import { coreErrors, couldNotRun, report } from "../core/result.mjs";
import { rules } from "../core/rules.mjs";
import { prepareChecker, runChecker } from "./checker.mjs";
import type { PrepareOptions, Prepared } from "./checker.mjs";
import { pluginDataDir } from "./data.mjs";
import { sessionStore } from "./guard.mjs";
import { detectHarnessName } from "./harnesses.mjs";
import { STOP_DEADLINE_MS, readStdin } from "./stdin.mjs";
import type { RegistrationCache } from "./registration.mjs";
import type { RunContext } from "./run.mjs";
import {
  denyReason,
  legacySet,
  recordUnregistered,
  runContext,
} from "./run.mjs";
import {
  emitAntigravityUsage,
  failedTarget,
  harnessName,
  recordAttrs,
  scrub,
} from "./telemetry.mjs";
import type { HookInput, HookSpecificOutput, StopDecision } from "./types.mjs";

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_UNTRACKED = 2000;
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

export type SyncRunner = (
  cmd: string,
  args: readonly string[],
  opts?: unknown,
) => SpawnSyncReturns<string>;

// What "unchanged" means: same HEAD, same diff against it, same untracked files, names and contents. Null outside
// a git repo, when git fails or past MAX_UNTRACKED untracked files, which means "always run".
export function fingerprint(
  cwd: string,
  run: SyncRunner = spawnSync as unknown as SyncRunner,
): string | null {
  const git = (args: readonly string[], input?: string) =>
    run("git", args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      input,
    });
  const parts = [
    git(["rev-parse", "HEAD"]),
    git(["diff", "HEAD"]),
    git(["ls-files", "-o", "--exclude-standard", "-z"]),
  ];
  if (parts.some((p) => p.status !== 0)) return null;
  const untrackedPart = parts[2];
  const untracked = (untrackedPart?.stdout ?? "").split("\0").filter(Boolean);
  if (untracked.length > MAX_UNTRACKED) return null;
  if (untracked.length) {
    const hashes = git(["hash-object", "--stdin-paths"], untracked.join("\n"));
    if (hashes.status !== 0) return null;
    parts.push(hashes);
  }
  return sha(parts.map((p) => p.stdout).join("\0"));
}

export interface RunDetachedResult {
  error?: Error;
  status: number | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

// Runs make with no terminal: stdin closed, output piped, in its own session (`detached`: setsid on Unix, its own
// process group), with CI=1 and TERM=dumb. Past `timeout` the whole group is killed, grandchildren included.
export function runDetached(
  cmd: string,
  args: readonly string[],
  { cwd, timeout }: { cwd: string; timeout: number },
): Promise<RunDetachedResult> {
  return new Promise((res) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(cmd, args as string[], {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, CI: "1", TERM: "dumb" },
    });
    const finish = (r: { error?: Error; status: number | null }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res({ stdout, stderr, timedOut, ...r });
    };
    child.stdout.on("data", (d: Buffer | string) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer | string) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (platform() === "win32") {
          spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            windowsHide: true,
          });
        } else if (child.pid) {
          process.kill(-child.pid, "SIGKILL");
        }
      } catch {
        child.kill("SIGKILL");
      }
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      finish({ status: null });
    }, timeout);
    child.on("error", (error) => {
      finish({ status: null, error });
    });
    child.on("close", (status) => {
      finish({ status });
    });
  });
}

export interface ChangeSet {
  paths: string[];
  rules: string;
}

// The paths changed since `base` (the last green run's HEAD; HEAD when there is none): `git diff` against it with
// renames split into delete and add, plus untracked files, all relative to the repo root, and the text of the repo's
// `.stop-check-ignore` ('' when it has none). Null when git cannot say, which means "run the check".
export function changes(
  cwd: string,
  base?: string,
  run: SyncRunner = spawnSync as unknown as SyncRunner,
): ChangeSet | null {
  const git = (args: readonly string[], at: string) =>
    run("git", args, { cwd: at, encoding: "utf8", windowsHide: true });
  const top = git(["rev-parse", "--show-toplevel"], cwd);
  const root = top.status === 0 ? top.stdout.trim() : "";
  if (!root) return null;
  const commit = base && /^[0-9a-f]{40,64}$/.test(base) ? base : "HEAD";
  const diff = git(
    ["diff", "--name-only", "--no-renames", "-z", commit, "--"],
    root,
  );
  const untracked = git(["ls-files", "-o", "--exclude-standard", "-z"], root);
  if (diff.status !== 0 || untracked.status !== 0) return null;
  const paths = `${diff.stdout}\0${untracked.stdout}`
    .split("\0")
    .filter(Boolean);
  let ruleText = "";
  try {
    ruleText = readFileSync(join(root, ".stop-check-ignore"), "utf8");
  } catch {
    // no repo rules: the defaults alone
  }
  return { paths, rules: ruleText };
}

const stateFile = (cwd: string): string =>
  join(pluginDataDir(), "stop", `${sha(cwd).slice(0, 16)}.txt`);

interface GreenState {
  fp?: string;
  head?: string;
}

function lastGreen(cwd: string): GreenState {
  try {
    const raw = readFileSync(stateFile(cwd), "utf8").trim();
    const [fp, head] = raw.split("\n");
    return { fp, head };
  } catch {
    return {};
  }
}

function markGreen(cwd: string, fp: string, run: SyncRunner): void {
  try {
    const head = run("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    });
    mkdirSync(join(stateFile(cwd), ".."), { recursive: true });
    writeFileSync(
      stateFile(cwd),
      head.status === 0 ? `${fp}\n${head.stdout.trim()}` : fp,
    );
  } catch {
    // best effort: the next stop just runs the check again
  }
}

// Why the host cannot take a check now, or null. Load average on Unix only (Windows reports 0), free disk everywhere.
export function hostStrain(
  cwd: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  try {
    const caps = hostCaps(env, rules.host);
    if (caps.off) return null;
    const load1 = loadavg()[0] ?? 0;
    if (platform() !== "win32" && load1 > caps.loadCap) {
      return `load ${String(Math.round(load1 * 10) / 10)}`;
    }
    const fs = statfsSync(cwd);
    const freeGb = (fs.bavail * fs.bsize) / 1073741824;
    return freeGb < caps.freeFloorGb
      ? `${String(Math.round(freeGb))} GB free`
      : null;
  } catch {
    return null;
  }
}

const lock = (cwd: string): (() => void) | null =>
  takeLock(`${stateFile(cwd)}.lock`);

export function takeLock(file: string): (() => void) | null {
  try {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, String(process.pid), { flag: "wx" });
    return () => {
      rmSync(file, { force: true });
    };
  } catch (err: unknown) {
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? (err as { code: string }).code
        : undefined;
    if (code !== "EEXIST") {
      return () => {
        // lock cleanup ignore
      };
    }
    try {
      const holderPid = Number(readFileSync(file, "utf8"));
      process.kill(holderPid, 0);
      return null;
    } catch {
      try {
        rmSync(file, { force: true });
        writeFileSync(file, String(process.pid), { flag: "wx" });
        return () => {
          rmSync(file, { force: true });
        };
      } catch {
        return null;
      }
    }
  }
}

const RESULT_GATE_MAX = 2;
const RESULT_MAX_BYTES = 1024 * 1024;
const COUNTER_MAX_BYTES = 64;

class ResultReadError extends Error {}

// A file's text: only a regular file up to `maxBytes`. Opened non-blocking and checked through the descriptor, so a
// FIFO or a device (the agent can plant one) is an error, never a read that hangs the hook.
function readRegularFile(
  file: string,
  maxBytes: number,
  tooLarge: string,
): string {
  // O_NONBLOCK does not exist on Windows
  const nonBlock = (constants as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0;
  const fd = openSync(file, constants.O_RDONLY | nonBlock);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new ResultReadError("not a regular file");
    if (st.size > maxBytes) throw new ResultReadError(tooLarge);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

const readResultFile = (file: string): string =>
  readRegularFile(file, RESULT_MAX_BYTES, "too large (over 1 MiB)");

const SUBAGENT_HINT =
  "A subagent ignores this and ends its turn: the main session writes the file.";
const DEFAULT_HINT = "Fix the result file until it passes the core check.";
const STRICT_HINT =
  "Fix the result file until it passes the core check and the runner's checker; never edit the checker.";

export interface CheckerOpts extends PrepareOptions {
  cache?: RegistrationCache;
  dataDir?: string;
  // True for a host that runs the hook in its own process (opencode, pi): a stop with no session id is then keyed on
  // that process id. Unset, the hook is a command run by the harness, keyed on its parent process id.
  inProcess?: boolean;
  timeoutMs?: number;
}

// A payload that is not a plain object counts as an empty one.
const plainInput = (v: unknown): HookInput =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v : {};

// A subagent's stop is never held: the main session owns the run.
const isSubagentStop = (input: HookInput): boolean =>
  Boolean(input.agent_id) ||
  /^subagentstop$/i.test(input.hook_event_name ?? "");

// The run's context for this stop, and the PrepareOptions part of `opts` that vets the manifest and its checker.
function stopContext(
  env: NodeJS.ProcessEnv,
  input: HookInput,
  opts: CheckerOpts,
): { ctx: RunContext; dataDir: string } {
  const dataDir = opts.dataDir ?? pluginDataDir(env);
  // the probes in `opts` are the PrepareOptions; its other keys are not read by the vetting
  const ctx = runContext(env, {
    dataDir,
    sessionId: input.session_id,
    cache: opts.cache,
    vet: opts,
  });
  return { ctx, dataDir };
}

// The gate never fails open once a registered run names a checker (strict) or runs unattended: the block reason for
// a stop whose check could not be made, or null for an attended run with no named checker, an exempt stop, a gate
// switched off or no run. A failed registration blocks whatever the switch says.
export function gateFailClosed(
  env: NodeJS.ProcessEnv,
  input: HookInput,
  why: string,
  opts: CheckerOpts = {},
): string | null {
  try {
    const raw = plainInput(input);
    if (isSubagentStop(raw)) return null;
    const { ctx } = stopContext(env, raw, opts);
    if (ctx.state === "deny") {
      return cappedRegistrationBlock(ctx, raw, opts)?.reason ?? null;
    }
    if (ctx.state === "none") return null;
    const result = ctx.registration.result;
    if (env.GUARD_RESULT_GATE === "off" || !result) return null;
    const strict = result.checker !== undefined;
    if (!(strict || ctx.mode === "unattended")) return null;
    const shown = scrub(why).slice(0, 200);
    return strict
      ? `Run result gate: could not check the result for run ${ctx.runId} (${shown}); the registration names a result checker, so the stop stays blocked.`
      : `Run result gate: could not check the result for run ${ctx.runId} (${shown}); an unattended run never fails open, so the stop stays blocked.`;
  } catch {
    // the gate's own failure must not open a run
    try {
      const raw = plainInput(input);
      const set = (k: string): boolean => (env[k] ?? "").trim() !== "";
      return !isSubagentStop(raw) &&
        (set("GUARD_RUN_ID") || set("GUARD_RUN_MANIFEST") || legacySet(env))
        ? "Run result gate: could not check the result for this run (internal error); the stop stays blocked."
        : null;
    } catch {
      return null;
    }
  }
}

// The block counter, one file per run: the only place it is read or written.
const blockFile = (runId: string): string =>
  join(pluginDataDir(), "result-gate", `${sha(runId).slice(0, 16)}.txt`);

// The count so far: only a regular, single-link file of at most 64 bytes holding 1-9 digits, opened without following
// a symlink, counts. Everything else (missing, empty, garbage, a FIFO, a directory, a symlink, a hardlink, an
// unreadable path) is 0, so the write below replaces it and the block is counted.
function blockCount(runId: string): number {
  try {
    const c = constants as { O_NONBLOCK?: number; O_NOFOLLOW?: number };
    const fd = openSync(
      blockFile(runId),
      constants.O_RDONLY | (c.O_NONBLOCK ?? 0) | (c.O_NOFOLLOW ?? 0),
    );
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.nlink > 1 || st.size > COUNTER_MAX_BYTES) return 0;
      const text = readFileSync(fd, "utf8").trim();
      return /^\d{1,9}$/.test(text) ? Number(text) : 0;
    } finally {
      closeSync(fd);
    }
  } catch {
    return 0;
  }
}

// Records one more block and returns the new count. Written to a temp file and renamed over the counter, so whatever
// sits at the counter path (a FIFO, a symlink) is replaced, never written through.
function bumpBlocks(runId: string): number {
  const n = blockCount(runId) + 1;
  const file = blockFile(runId);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${String(process.pid)}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, String(n), { flag: "wx" });
    renameSync(tmp, file);
  } catch (e: unknown) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return n;
}

// The registration-deny cap key: the session id when the host sends one. Without one, the cwd plus a process id that
// is stable for the session: the parent's for a command hook (the harness when its shell execs the command), whose own pid is new on every stop; this
// process's for an in-process host (`inProcess`).
function registrationKey(input: HookInput, opts: CheckerOpts = {}): string {
  if (input.session_id) return input.session_id;
  const pid = opts.inProcess ? process.pid : process.ppid;
  return `${input.cwd ?? process.cwd()}:${String(pid)}`;
}

// A failed registration blocks the stop at most RESULT_GATE_MAX times per key: the agent cannot fix it and every tool
// call is already denied, so an uncapped block would only loop the session. Null once capped. A counter that cannot
// be written still blocks.
function cappedRegistrationBlock(
  ctx: Extract<RunContext, { state: "deny" }>,
  input: HookInput,
  opts: CheckerOpts = {},
): { reason: string; n: number } | null {
  const key = `registration:${registrationKey(input, opts)}`;
  if (blockCount(key) >= RESULT_GATE_MAX) return null;
  let n = blockCount(key) + 1;
  try {
    n = bumpBlocks(key);
  } catch {
    // a counter that cannot be written still blocks
  }
  return {
    reason: `${denyReason(ctx, "stop")} (block ${String(n)} of ${String(RESULT_GATE_MAX)})`,
    n,
  };
}

// No result file path segment may be a git directory under any spelling a filesystem folds onto it: trailing dots and
// spaces (Windows), case (macOS, Windows) and 8.3 short names.
const GIT_SEGMENT = /^(\.git(hub)?|git(hub)?~\d+)$/i;

// The real path of `rel` under `root`: symlinks resolved through the nearest existing ancestor, the missing rest
// appended. Throws when it leaves the repo or goes under .git or .github.
function resolveResultFile(root: string, rel: string): string {
  const realRoot = realpathSync(root);
  let existing = join(root, rel);
  const rest: string[] = [];
  let real: string;
  for (;;) {
    try {
      real = realpathSync(existing);
      break;
    } catch (e: unknown) {
      const code = (e as { code?: string }).code;
      const up = dirname(existing);
      if ((code !== "ENOENT" && code !== "ENOTDIR") || up === existing) throw e;
      rest.unshift(basename(existing));
      existing = up;
    }
  }
  const resolved = join(real, ...rest);
  const inside = relative(realRoot, resolved);
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error("result file resolves outside the repo");
  }
  if (
    inside.split(sep).some((seg) => GIT_SEGMENT.test(seg.replace(/[. ]+$/, "")))
  ) {
    throw new Error("result file resolves under .git or .github");
  }
  return resolved;
}

export async function resultGate(
  input: HookInput,
  run: SyncRunner = spawnSync as unknown as SyncRunner,
  env: NodeJS.ProcessEnv = process.env,
  onEvent: (attrs: Record<string, unknown>) => void = () => {
    // default event ignore
  },
  checkerOpts: CheckerOpts = {},
): Promise<string | null> {
  const event = (result: string, attrs: Record<string, unknown> = {}): void => {
    onEvent({ result, target: "result-gate", ...attrs });
  };
  const payload = plainInput(input);
  if (isSubagentStop(payload)) return null;

  try {
    const { ctx, dataDir } = stopContext(env, payload, checkerOpts);
    if (ctx.state === "deny") {
      // Not switched off by GUARD_RESULT_GATE. Capped like result errors, per session: the agent cannot fix a
      // registration and every tool call guard sees is already denied, so an uncapped block would only loop the session.
      if (ctx.rule === UNREGISTERED_RULE) {
        recordUnregistered(env, dataDir, registrationKey(payload, checkerOpts));
      }
      const blocked = cappedRegistrationBlock(ctx, payload, checkerOpts);
      if (blocked === null) {
        event("capped", { rule: ctx.rule });
        return null;
      }
      event("registration", { rule: ctx.rule, blocks: blocked.n });
      return blocked.reason;
    }
    if (ctx.state === "none") return null;
    const { registration, runId } = ctx;
    const spec = registration.result;
    if (env.GUARD_RESULT_GATE === "off" || !spec) return null;
    const cwd = payload.cwd ?? process.cwd();
    const strict = spec.checker !== undefined;
    const runtime = ctx.mode === "unattended";
    const mode = ctx.mode;

    // Resolved once, before the result is read.
    const checker: Prepared | null =
      spec.checker === undefined
        ? null
        : prepareChecker(spec.checker, checkerOpts);
    const checkerShown = checker?.shown ?? "";

    const git = run(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd, encoding: "utf8", windowsHide: true },
    );
    if (git.status !== 0 || !git.stdout.trim()) {
      if (strict || runtime) throw new Error("git rev-parse failed");
      return null;
    }
    const root = dirname(git.stdout.trim());
    const template = resultFile(spec.file, {
      run_id: runId,
      ticket_number: ctx.ticketNumber,
    });
    if ("why" in template) throw new Error(template.why);
    const file = resolveResultFile(root, template.path);

    let errors: string[] = [];
    let parsed: unknown;
    let parsedOk = false;
    const coreEnv: Record<string, string | undefined> = runtime
      ? {
          GUARD_RUN_ID: runId,
          ...(ctx.ticket ? { GUARD_RUN_TICKET: ctx.ticket } : {}),
        }
      : {};
    const checkEnv: Record<string, string | undefined> = runtime
      ? {
          ...env,
          ...(ctx.runFile ? { GUARD_RUN_FILE: resolve(cwd, ctx.runFile) } : {}),
        }
      : {};
    try {
      const content = readResultFile(file).replace(/^\uFEFF/, "");
      parsed = JSON.parse(content);
      parsedOk = true;
    } catch (e: unknown) {
      if (!runtime) return null;
      const err = e as { code?: string; message?: string };
      errors = [
        e instanceof ResultReadError
          ? e.message
          : err.code === "ENOENT"
            ? "no such file"
            : e instanceof SyntaxError
              ? `not valid JSON (${err.message ?? ""})`
              : `cannot read (${err.code ?? err.message ?? ""})`,
      ];
    }
    if (parsedOk) {
      if (
        !runtime &&
        (parsed === null ||
          typeof parsed !== "object" ||
          (parsed as { run_id?: unknown }).run_id !== runId)
      ) {
        return null;
      }
      errors = coreErrors(parsed, coreEnv);
    }

    // The checker can only add errors: the core ones always stay.
    if (checker && "why" in checker) {
      errors.push(...couldNotRun(checkerShown, checker.why));
    } else if (checker && parsedOk) {
      const r = await runChecker(checker.path, parsed, checkEnv, {
        timeoutMs: checkerOpts.timeoutMs,
      });
      errors.push(
        ...("errors" in r ? r.errors : couldNotRun(checkerShown, r.why)),
      );
    }
    errors = [...new Set(errors)];

    if (!errors.length) return null;
    const blocks = blockCount(runId);
    if (!strict && blocks >= RESULT_GATE_MAX) {
      event("capped", { mode });
      return null;
    }
    const n = bumpBlocks(runId);
    event("block", { mode, blocks: n });
    const head = strict
      ? `Run result gate (block ${String(n)}; the registration names a result checker, so the stop stays blocked until the result passes)`
      : `Run result gate (block ${String(n)} of ${String(RESULT_GATE_MAX)})`;
    return [
      `${head}: ${file} is not a valid result for run ${runId}:`,
      ...report(errors),
      spec.hint ?? (strict ? STRICT_HINT : DEFAULT_HINT),
      SUBAGENT_HINT,
    ].join("\n");
  } catch (e: unknown) {
    const err =
      typeof e === "object" && e !== null && "message" in e
        ? (e as { message: string }).message
        : String(e);
    event("error", { why: scrub(err).slice(0, 200) });
    return gateFailClosed(env, input, err, checkerOpts);
  }
}

export interface StopCheckOptions {
  exec?: (
    cmd: string,
    args: readonly string[],
    opts: {
      cwd: string;
      encoding: string;
      timeout: number;
      windowsHide: boolean;
    },
  ) => Promise<RunDetachedResult>;
  gate?: CheckerOpts;
  report?: (attrs: Record<string, unknown>) => void;
  strain?: (cwd: string) => string | null;
  // Called with the gate's answer (null = the result passed) before the make check starts, so a crash during the check
  // cannot undo what the gate decided.
  onGate?: (reason: string | null) => void;
}

// What the gate decided so far, for a crash later in the stop.
export interface GateState {
  done: boolean;
  reason: string | null;
}

const blockOf = (reason: string): StopCheckResult => ({
  decision: "block",
  reason,
  hookSpecificOutput: { hookEventName: "Stop", decision: "block", reason },
});

// The answer to a crash: nothing for a gate that passed, the gate's own block for one that blocked, and the fail-closed
// gate answer when the gate had not finished.
export function crashAnswer(
  gate: GateState,
  env: NodeJS.ProcessEnv,
  input: HookInput,
  why = "internal error",
): StopCheckResult | null {
  if (gate.done) return gate.reason ? blockOf(gate.reason) : null;
  const reason = gateFailClosed(env, input, why);
  return reason ? blockOf(reason) : null;
}

class StdinReadError extends Error {}

export interface StopCheckResult {
  decision?: StopDecision;
  hookSpecificOutput?: HookSpecificOutput;
  reason?: string;
  systemMessage?: string;
}

export async function stopCheck(
  input: HookInput,
  run: SyncRunner = spawnSync as unknown as SyncRunner,
  opts: StopCheckOptions = {},
): Promise<StopCheckResult | null> {
  const gate = await resultGate(
    input,
    run,
    process.env,
    opts.report,
    opts.gate,
  );
  try {
    opts.onGate?.(gate);
  } catch {
    // a bookkeeping callback never changes the answer
  }
  let check: StopCheckResult | null = null;
  try {
    check = await makeCheck(input, run, opts);
  } catch {
    // a failing make check never denies a stop (a gate block or a result that passed): it fails open
    check = null;
  }
  if (!gate) return check;
  const reason =
    check?.decision === "block" ? `${gate}\n\n${check.reason ?? ""}` : gate;
  return {
    ...(check?.systemMessage ? { systemMessage: check.systemMessage } : {}),
    decision: "block",
    reason,
    hookSpecificOutput: { hookEventName: "Stop", decision: "block", reason },
  };
}

async function makeCheck(
  input: HookInput,
  run: SyncRunner = spawnSync as unknown as SyncRunner,
  {
    exec = run === (spawnSync as unknown as SyncRunner)
      ? runDetached
      : (c, a, o) => {
          const res = run(c, a, o);
          const errCode =
            res.error && "code" in res.error
              ? (res.error as { code?: string }).code
              : undefined;
          return Promise.resolve({
            stdout: res.stdout,
            stderr: res.stderr,
            status: res.status,
            error: res.error,
            timedOut: errCode === "ETIMEDOUT",
          });
        },
    strain = hostStrain,
    report = () => {
      // default report ignore
    },
  }: StopCheckOptions = {},
): Promise<StopCheckResult | null> {
  if (input.stop_hook_active || process.env.GUARD_STOP_CHECK === "off") {
    return null;
  }
  const cwd = input.cwd ?? process.cwd();
  const timeout =
    Number(process.env.GUARD_STOP_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const opts = { cwd, encoding: "utf8", timeout, windowsHide: true };
  const target = (["check-fast", "check"] as const).find(
    (t) => run("make", ["-n", t], opts).status === 0,
  );
  if (!target) return null;
  const fp = fingerprint(cwd, run);
  const green = lastGreen(cwd);
  if (fp && fp === green.fp) return null;

  const changed = changes(cwd, green.head, run);
  if (changed?.paths.length === 0 && process.env.GUARD_STOP_CHECK !== "force") {
    return null;
  }
  if (
    changed &&
    changed.paths.length > 0 &&
    docsOnly(changed.paths, changed.rules)
  ) {
    return null;
  }

  const deferred = (
    why: string,
    attrs: Record<string, unknown> = {},
  ): StopCheckResult => {
    report({ result: "deferred", target, why, ...attrs });
    return {
      systemMessage: `make ${target} deferred (${why}); it runs at the next stop. Run it before you ship.`,
    };
  };

  const strained =
    process.env.GUARD_STOP_CHECK === "force" ? null : strain(cwd);
  if (strained) return deferred(`host strained: ${strained}`);

  const unlock = lock(cwd);
  if (!unlock) return deferred("another stop check is running in this repo");

  const started = Date.now();
  let r: RunDetachedResult;
  try {
    r = await exec("make", [target], opts);
  } finally {
    unlock();
  }

  const done = (result: string): void => {
    report({ result, target, duration_ms: Date.now() - started });
  };

  if (r.status === 0) {
    if (fp) markGreen(cwd, fp, run);
    done("pass");
    return null;
  }

  if (
    r.timedOut ||
    (r.error as { code?: string } | undefined)?.code === "ETIMEDOUT"
  ) {
    return deferred(
      `did not finish within ${String(Math.round(timeout / 1000))} s`,
      { duration_ms: Date.now() - started },
    );
  }

  const all = `${r.stdout}${r.stderr}`.trimEnd();
  const allLines = all.split("\n");
  const lastLine = allLines[allLines.length - 1];
  report({
    result: "fail",
    target,
    duration_ms: Date.now() - started,
    failed_target: failedTarget(all),
    last_line: scrub(lastLine),
  });

  const out = allLines.slice(-40).join("\n");
  const fallbackError =
    r.error?.message ?? `exit ${String(r.status ?? "unknown")}`;
  const reason = `make ${target} failed; fix before finishing:\n${out ? out : fallbackError}`;
  return {
    decision: "block",
    reason,
    hookSpecificOutput: { hookEventName: "Stop", decision: "block", reason },
  };
}

interface AntigravityStopInput {
  conversationId?: string;
  cwd?: string;
  hook_event_name?: string;
  modelName?: string;
  session_id?: string;
  terminationReason?: unknown;
  transcriptPath?: string;
  workspacePaths?: readonly string[];
}

const entryArg = process.argv[1];
if (entryArg && import.meta.url === pathToFileURL(entryArg).href) {
  const flagHarness = process.argv
    .find((a) => a.startsWith("--harness="))
    ?.slice(10);
  const activeHarness = flagHarness ?? detectHarnessName();
  let input: AntigravityStopInput = {};
  const isAntigravity = (): boolean =>
    activeHarness === "antigravity" || input.terminationReason !== undefined;
  // Stdout carries one JSON object, written at most once, in the shape each harness reads.
  let written = false;
  const writeOut = (out: StopCheckResult | null): void => {
    if (!out || written) return;
    written = true;
    if (isAntigravity()) {
      process.stdout.write(
        JSON.stringify(
          out.decision === "block"
            ? { decision: "continue", reason: out.reason }
            : {},
        ),
      );
    } else if (activeHarness === "codex" && out.decision) {
      process.stdout.write(
        JSON.stringify({ decision: out.decision, reason: out.reason }),
      );
    } else {
      process.stdout.write(JSON.stringify(out));
    }
  };
  // A crash outside the try below (an uncaught exception or rejection) answers like an internal error: a block when
  // the gate never fails open, nothing otherwise, and always exit 0. Once the gate answered, a crash in the usage or
  // telemetry steps changes nothing: a passed result stays passed.
  let crashed = false;
  let answered = false;
  const gateState: GateState = { done: false, reason: null };
  const failClosedOnCrash = (): void => {
    if (crashed) process.exit(0);
    crashed = true;
    try {
      if (!answered) writeOut(crashAnswer(gateState, process.env, input));
    } catch {
      // never exit non-zero by accident
    }
    try {
      process.stdout.write("", () => {
        process.exit(0);
      });
    } catch {
      process.exit(0);
    }
  };
  process.on("uncaughtException", failClosedOnCrash);
  process.on("unhandledRejection", failClosedOnCrash);
  try {
    const read = await readStdin(process.stdin, {
      deadlineMs: STOP_DEADLINE_MS,
    });
    if (!read.ok) throw new StdinReadError(read.why);
    input = plainInput(JSON.parse(read.text || "{}"));
    if (input.terminationReason !== undefined && !input.hook_event_name) {
      input.hook_event_name = "Stop";
    }
    if (input.conversationId && !input.session_id) {
      input.session_id = input.conversationId;
    }
    const firstWorkspace = input.workspacePaths?.[0];
    if (firstWorkspace && !input.cwd) {
      input.cwd = firstWorkspace;
    }

    const events: Record<string, unknown>[] = [];
    const out = await stopCheck(input, spawnSync as unknown as SyncRunner, {
      report: (attrs) => events.push(attrs),
      onGate: (reason) => {
        gateState.done = true;
        gateState.reason = reason;
      },
    });

    // written before the usage and telemetry steps, so a failure there cannot lose a block or deny a passed result
    writeOut(out);
    answered = true;

    try {
      if (
        isAntigravity() &&
        (input.transcriptPath ||
          (input as { transcript_path?: string }).transcript_path)
      ) {
        const tPath =
          input.transcriptPath ??
          (input as { transcript_path?: string }).transcript_path;
        const dataDir = pluginDataDir();
        const store = sessionStore(dataDir, input.session_id);
        const state = store.load();
        const newStep = await emitAntigravityUsage(
          tPath,
          input.conversationId ?? input.session_id,
          input.modelName,
          state.lastTranscriptStep,
          process.env,
        );
        if (newStep !== undefined && newStep !== state.lastTranscriptStep) {
          state.lastTranscriptStep = newStep;
          store.save(state);
        }
      }
    } catch {
      // telemetry only
    }

    try {
      for (const event of events) {
        await emit(
          process.env,
          "guard.stop",
          recordAttrs(
            { ...event, cmd_class: "stop", session_id: input.session_id },
            input.cwd ?? process.cwd(),
            harnessName(),
          ),
        );
      }
    } catch {
      // telemetry only
    }
  } catch (e: unknown) {
    // unreadable payload or an internal error in the gate: let the agent stop, unless a run is identified, in which
    // case the stop stays blocked
    try {
      if (!answered) {
        const why =
          e instanceof StdinReadError
            ? `could not read the hook input (${e.message})`
            : "internal error";
        writeOut(crashAnswer(gateState, process.env, input, why));
      }
    } catch {
      // never exit non-zero by accident
    }
  }
  // Exits once the answer is flushed (stdout to a pipe may be async), so idle handles cannot hold the hook open. The
  // checker runs in a child process killed on timeout, so even one blocked in a system call cannot.
  await new Promise<void>((done) => {
    process.stdout.write("", () => {
      done();
    });
  });
  process.exit(0);
}
