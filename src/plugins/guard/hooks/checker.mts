// The launcher's result checker for the stop hook's result gate: vetting its path, running it in a child process.

import { type ChildProcess, spawn } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { checkerPathError, report } from "../core/result.mjs";
import { scrub } from "./telemetry.mjs";

// THE SINGLE TRANSITION SEAM. While the factory plugin ships in this repository, an unset FACTORY_RESULT_CHECKER
// falls back to the build copy of its checker. The change that removes that plugin from this repository deletes
// BUILD_COPY, defaultChecker and DEFAULT_WRITE_HINT; after that, unset means the core check only. The build copy is
// exempt from the writability rule: it is guard's own install.
export const BUILD_COPY = fileURLToPath(
  new URL("../.generated/factory/check-result.mjs", import.meta.url),
);

export const defaultChecker = (
  buildCopy: string = BUILD_COPY,
): { path: string } | null =>
  existsSync(buildCopy) ? { path: buildCopy } : null;

// Part of the seam: the hand-back line that names the default checker's writer script.
export const DEFAULT_WRITE_HINT =
  "Write it with the ticket-run skill's scripts/write-result.mjs, never by hand: put the judgment fields in a JSON file and run `node <skill dir>/scripts/write-result.mjs <file>` from the repo; fix the input, never the written file, until it exits 0.";

const STICKY = 0o1000;

type Platform = NodeJS.Platform;

const accessCode = (target: string): string | undefined => {
  try {
    accessSync(target, constants.W_OK);
    return undefined;
  } catch (e: unknown) {
    return (e as { code?: string }).code ?? "unknown";
  }
};

// Whether this user can write `target` right now. EROFS (a read-only mount), EACCES and EPERM mean it cannot; any
// other error is not known to be safe, so it counts as writable (fails closed). On win32 only the access result
// counts (the read-only attribute): ACLs are the launcher's job, and the check does not prove them there.
export function isWritableByMe(
  target: string,
  platform: Platform = process.platform,
): boolean {
  const code = accessCode(target);
  if (code === undefined) return true;
  if (platform === "win32") return false;
  return !["EROFS", "EACCES", "EPERM"].includes(code);
}

// Whether `target` is on a read-only mount: a file there cannot be chmodded, so owning it gives no reach.
export function isReadOnlyMount(target: string): boolean {
  return accessCode(target) === "EROFS";
}

// Whether this user owns `target`. Fails closed.
function isOwnedByMe(target: string): boolean {
  try {
    return statSync(target).uid === process.getuid?.();
  } catch {
    return true;
  }
}

function isSticky(target: string): boolean {
  try {
    return (statSync(target).mode & STICKY) !== 0;
  } catch {
    return false;
  }
}

export interface PrepareOptions {
  owner?: (target: string) => boolean;
  platform?: Platform;
  readOnlyMount?: (target: string) => boolean;
  sticky?: (target: string) => boolean;
  writable?: (target: string) => boolean;
}

export type Prepared =
  { path: string; shown: string } | { shown: string; why: string };

const WRITABLE_TAIL =
  "install it owned by another user and not writable by this one, or on a read-only mount";

// Vets the raw FACTORY_RESULT_CHECKER value: { path, shown } or { why, shown }. Never throws. The file, its directory
// and every ancestor directory must be out of this user's reach: an owned or plainly writable directory lets the user
// rename it and swap the module between this check and the import (a sticky writable one, like /tmp, does not). A
// path on a read-only mount cannot be chmodded, so there the owner check is skipped for that path.
export function prepareChecker(
  raw: unknown,
  opts: PrepareOptions = {},
): Prepared {
  const platform = opts.platform ?? process.platform;
  const writable = opts.writable ?? ((t) => isWritableByMe(t, platform));
  const owner = opts.owner ?? isOwnedByMe;
  const readOnly = opts.readOnlyMount ?? isReadOnlyMount;
  const sticky = opts.sticky ?? isSticky;
  const shown = typeof raw === "string" ? raw.trim() : "";
  try {
    const bad = checkerPathError(
      shown,
      platform === "win32" ? path.win32 : path,
    );
    if (bad) return { why: bad, shown };
    let real: string;
    try {
      real = realpathSync(shown);
    } catch (e: unknown) {
      const code = (e as { code?: string }).code;
      return {
        why:
          code === "ENOENT"
            ? "no such file"
            : `cannot resolve (${code ?? "error"})`,
        shown,
      };
    }
    if (path.extname(real).toLowerCase() !== ".mjs") {
      return {
        why: `not a .mjs file (resolves to ${real.length > 200 ? `${real.slice(0, 200)}…` : real})`,
        shown,
      };
    }
    if (!statSync(real).isFile()) return { why: "not a regular file", shown };
    try {
      accessSync(real, constants.R_OK);
    } catch {
      return { why: "not readable", shown };
    }
    const refuse = (which: string): Prepared => ({
      why: `writable by this user (${which}): ${WRITABLE_TAIL}`,
      shown,
    });
    // out of reach: not writable, and (off a read-only mount) not owned either, as the owner can chmod it
    const reach = (t: string): boolean =>
      writable(t) || (platform !== "win32" && !readOnly(t) && owner(t));
    if (reach(real)) return refuse("the file");
    if (platform !== "win32") {
      const dir = path.dirname(real);
      if (reach(dir)) return refuse("its directory");
      for (let a = dir; ;) {
        if (!readOnly(a) && (owner(a) || (writable(a) && !sticky(a)))) {
          return refuse(`ancestor ${a}`);
        }
        const up = path.dirname(a);
        if (up === a) break;
        a = up;
      }
    }
    return { path: real, shown };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { why: `cannot be checked (${scrub(msg).slice(0, 100)})`, shown };
  }
}

export type RunResult = { errors: string[] } | { why: string };

const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((e) => typeof e === "string");

// The child's message is re-validated here: the checker module could post one of its own.
function acceptMessage(m: unknown): RunResult {
  if (m !== null && typeof m === "object") {
    const o = m as { errors?: unknown; why?: unknown };
    if (isStrings(o.errors) && o.why === undefined) {
      // the child already capped it (50 lines and a "… and N more" marker): only a message that exceeds that is
      // re-capped, so the marker's count survives
      return {
        errors:
          o.errors.length <= 51
            ? o.errors.map((e) => (e.length > 301 ? `${e.slice(0, 300)}…` : e))
            : report(o.errors),
      };
    }
    if (typeof o.why === "string" && o.errors === undefined) {
      return { why: o.why.slice(0, 300) };
    }
  }
  return { why: "sent an invalid message" };
}

const errText = (e: unknown): string =>
  scrub(e instanceof Error ? e.message : String(e)).slice(0, 200);

// The runtime that runs the checker: this one when it is Node (opencode's host is Bun, whose execPath is the opencode
// binary), else `node` from the PATH.
const nodeBinary = (): string =>
  !process.versions.bun &&
  /^node(\.exe)?$/i.test(path.basename(process.execPath))
    ? process.execPath
    : "node";

const RUNNER = fileURLToPath(new URL("./checker-run.mjs", import.meta.url));

// Runs the checker in a child process: resolves { errors } or { why }, never rejects. Its console output is discarded.
// A process, not a thread: one blocked in a syscall (a FIFO the session planted) can be killed.
export function runChecker(
  checkerPath: string,
  result: unknown,
  env: Readonly<Record<string, string | undefined>>,
  { timeoutMs = 10_000 }: { timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    let done = false;
    let child: ChildProcess | undefined;
    let timer: NodeJS.Timeout | undefined;
    const finish = (r: RunResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        if (child?.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        if (child?.connected) child.disconnect();
        child?.unref();
      } catch {
        // already gone
      }
      resolve(r);
    };
    try {
      child = spawn(nodeBinary(), ["--max-old-space-size=128", RUNNER], {
        env: process.env,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        windowsHide: true,
      });
      child.on("message", (m: unknown) => {
        finish(acceptMessage(m));
      });
      child.on("error", (e: unknown) => {
        finish({ why: `could not start (${errText(e)})` });
      });
      // after the IPC channel closed, so a message sent just before the exit is not lost
      child.on("close", (code, signal) => {
        finish({
          why: `exited with ${signal ? `signal ${signal}` : `code ${String(code)}`} before answering`,
        });
      });
      timer = setTimeout(() => {
        finish({ why: `timed out after ${String(timeoutMs / 1000)} s` });
      }, timeoutMs);
      child.send({
        href: pathToFileURL(checkerPath).href,
        result,
        env: { ...env },
      });
    } catch (e: unknown) {
      finish({ why: `could not start (${errText(e)})` });
    }
  });
}
