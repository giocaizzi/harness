// The launcher's result checker for the stop hook's result gate: vetting its path, running it in a worker thread.

import {
  accessSync,
  constants,
  existsSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

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

// Whether this user can write `target`, or could make it writable (the owner can chmod it back). Fails closed. On
// win32 only the access result counts (the read-only attribute): ACLs are the launcher's job, and the check does not
// prove them there.
export function isWritableByMe(
  target: string,
  platform: Platform = process.platform,
): boolean {
  try {
    accessSync(target, constants.W_OK);
    return true;
  } catch (e: unknown) {
    try {
      if ((e as { code?: string }).code === "EROFS") return false;
      if (platform !== "win32") {
        return statSync(target).uid === process.getuid?.();
      }
      return false;
    } catch {
      return true;
    }
  }
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
  sticky?: (target: string) => boolean;
  writable?: (target: string) => boolean;
}

export type Prepared =
  { path: string; shown: string } | { shown: string; why: string };

const WRITABLE_TAIL =
  "install it read-only, owned by another user or on a read-only mount";

// Vets the raw FACTORY_RESULT_CHECKER value: { path, shown } or { why, shown }. Never throws. The file, its directory
// and every ancestor directory must be out of this user's reach: an owned or plainly writable directory lets the user
// rename it and swap the module between this check and the import (a sticky writable one, like /tmp, does not).
export function prepareChecker(
  raw: unknown,
  opts: PrepareOptions = {},
): Prepared {
  const platform = opts.platform ?? process.platform;
  const writable = opts.writable ?? ((t) => isWritableByMe(t, platform));
  const owner = opts.owner ?? isOwnedByMe;
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
    if (writable(real) || (platform !== "win32" && owner(real))) {
      return refuse("the file");
    }
    if (platform !== "win32") {
      const dir = path.dirname(real);
      if (writable(dir) || owner(dir)) return refuse("its directory");
      for (let a = dir; ;) {
        if (owner(a) || (writable(a) && !sticky(a))) {
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

// The worker's message is re-validated here: the checker module could post one of its own.
function acceptMessage(m: unknown): RunResult {
  if (m !== null && typeof m === "object") {
    const o = m as { errors?: unknown; why?: unknown };
    if (isStrings(o.errors) && o.why === undefined) {
      // the worker already capped it (50 lines and a "… and N more" marker): only a message that exceeds that is
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

// Runs the checker in a worker thread: resolves { errors } or { why }, never rejects. Its console output is discarded.
export function runChecker(
  checkerPath: string,
  result: unknown,
  env: Readonly<Record<string, string | undefined>>,
  { timeoutMs = 10_000 }: { timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    let done = false;
    let worker: Worker | undefined;
    let timer: NodeJS.Timeout | undefined;
    const finish = (r: RunResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        worker?.terminate().catch(() => {
          // already gone
        });
      } catch {
        // already gone
      }
      resolve(r);
    };
    try {
      worker = new Worker(new URL("./checker-worker.mjs", import.meta.url), {
        workerData: {
          href: pathToFileURL(checkerPath).href,
          result,
          env: { ...env },
        },
        resourceLimits: { maxOldGenerationSizeMb: 128 },
        stdout: true,
        stderr: true,
      });
      worker.stdout.resume();
      worker.stderr.resume();
      worker.on("message", (m: unknown) => {
        finish(acceptMessage(m));
      });
      worker.on("error", (e: unknown) => {
        finish({ why: `threw (${errText(e)})` });
      });
      worker.on("exit", (code) => {
        finish({ why: `exited with code ${String(code)} before answering` });
      });
      timer = setTimeout(() => {
        finish({ why: `timed out after ${String(timeoutMs / 1000)} s` });
      }, timeoutMs);
    } catch (e: unknown) {
      finish({ why: `could not start (${errText(e)})` });
    }
  });
}
