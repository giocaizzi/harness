// Run contract v2: loads the runner's registration from GUARD_RUN_MANIFEST, on every hook call. The manifest (and its
// result.checker) must be out of this user's reach, vetted as the result checker is (hooks/checker.mjs), and its
// realpath and sha256 are pinned in the session's state on first sight: a later change denies. Every failure is a
// deny with rule run-registration (fails closed); nothing here throws. Enforced from guard 1.0.0. The pin also holds
// the run id, the mode and the ticket (GUARD_RUN_*) the session started with: a later change denies.

import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import path from "node:path";

import { DEFAULT_PROTECTED_LIMITS } from "../core/constants.mjs";
import type { Registration, Validation } from "../core/registration.mjs";
import {
  MAX_MANIFEST_BYTES,
  parseRegistration,
  RULE,
  runEnvErrors,
} from "../core/registration.mjs";
import { rawPath } from "../core/result.mjs";
import type { PrepareOptions } from "./checker.mjs";
import { vetTrustedFile } from "./checker.mjs";
import { scrub } from "./telemetry.mjs";

export type Loaded =
  | { state: "none" }
  | {
      checker?: string;
      path: string;
      registration: Registration;
      sha256: string;
      state: "registered";
    }
  | { rule: "run-registration"; state: "deny"; why: string };

interface CacheEntry {
  key: string;
  validation: Validation;
}

// In-process harnesses (opencode, pi) keep one per process: the parsed manifest (one entry, replaced) is reused while
// the realpath and sha256 are unchanged; the file is read, hashed, vetted and pinned on every call.
export interface RegistrationCache {
  clear(): void;
  entry?: CacheEntry;
}

export interface LoadOptions {
  cache?: RegistrationCache;
  dataDir?: string;
  // default process.platform: selects the path rules and the open flags
  platform?: NodeJS.Platform;
  sessionId?: string;
  vet?: PrepareOptions;
}

export function createRegistrationCache(): RegistrationCache {
  const cache: RegistrationCache = {
    clear() {
      cache.entry = undefined;
    },
  };
  return cache;
}

// The session's pin file: <dataDir>/sessions/<session id>.run.jsonl, next to its facts file.
export function pinFile(dataDir: string, sessionId: string): string {
  return path.join(
    dataDir,
    "sessions",
    `${sessionId.replace(/[^\w-]/g, "_")}.run.jsonl`,
  );
}

const SHA = /^[0-9a-f]{64}$/;
const codeOf = (e: unknown): string => (e as { code?: string }).code ?? "error";

interface Pin {
  manifest: string;
  mode: string;
  run_id: string;
  sha256: string;
  ticket: string;
}

// The pin is the first line that is an object with string manifest, run_id, mode and ticket and a 64-hex sha256; other
// lines are ignored.
function firstPin(text: string): Pin | undefined {
  for (const line of text.split("\n")) {
    try {
      const o: unknown = JSON.parse(line);
      if (typeof o === "object" && o !== null && !Array.isArray(o)) {
        const { manifest, sha256, run_id, mode, ticket } = o as Record<
          string,
          unknown
        >;
        if (
          typeof manifest === "string" &&
          typeof sha256 === "string" &&
          typeof run_id === "string" &&
          typeof mode === "string" &&
          typeof ticket === "string" &&
          SHA.test(sha256)
        ) {
          return { manifest, sha256, run_id, mode, ticket };
        }
      }
    } catch {
      // not a pin line
    }
  }
  return undefined;
}

// The file's bytes, read from the open descriptor: at most MAX_MANIFEST_BYTES, or null when it has more.
function readBounded(fd: number): Buffer | null {
  const buf = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
  let n = 0;
  while (n < buf.length) {
    const got = readSync(fd, buf, n, buf.length - n, null);
    if (got === 0) break;
    n += got;
  }
  return n > MAX_MANIFEST_BYTES ? null : buf.subarray(0, n);
}

// The registration for this hook call: none (no GUARD_RUN_* variable), registered, or a deny with rule
// run-registration. Never throws.
export function loadRegistration(
  env: Readonly<Record<string, string | undefined>>,
  opts: LoadOptions = {},
): Loaded {
  const deny = (why: string): Loaded => ({ rule: RULE, state: "deny", why });
  try {
    const platform = opts.platform ?? process.platform;
    const pathApi = platform === "win32" ? path.win32 : path;
    const vetOpts: PrepareOptions = { platform, ...opts.vet };
    const m = env.GUARD_RUN_MANIFEST;
    const idSet = (env.GUARD_RUN_ID ?? "").trim() !== "";
    if (m === undefined && !idSet) return { state: "none" };
    if (idSet && (m === undefined || m.trim() === "")) {
      return deny("GUARD_RUN_ID is set but GUARD_RUN_MANIFEST is not");
    }
    if (m === undefined) throw new Error("unreachable");
    if (!idSet) {
      return deny("GUARD_RUN_MANIFEST is set but GUARD_RUN_ID is not");
    }
    if (m.includes("\n") || m.includes("\r")) {
      return deny("GUARD_RUN_MANIFEST names more than one path");
    }
    const at = `manifest ${rawPath(m)} (GUARD_RUN_MANIFEST)`;
    const vet = vetTrustedFile(m, ".json", vetOpts);
    if (!("path" in vet)) return deny(`${at}: ${vet.why}`);
    const real = vet.path;

    let validation: Validation;
    let sha256: string;
    const fd = openSync(
      real,
      constants.O_RDONLY | (platform === "win32" ? 0 : constants.O_NONBLOCK),
    );
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) return deny(`${at}: not a regular file`);
      if (st.size > MAX_MANIFEST_BYTES) {
        return deny(`${at}: too large (over 64 KiB)`);
      }
      const bytes = readBounded(fd);
      if (!bytes) return deny(`${at}: too large (over 64 KiB)`);
      sha256 = createHash("sha256").update(bytes).digest("hex");
      const key = `${real}\0${sha256}`;
      const hit = opts.cache?.entry;
      if (hit?.key === key) {
        validation = hit.validation;
      } else {
        validation = parseRegistration(
          bytes,
          DEFAULT_PROTECTED_LIMITS,
          pathApi,
        );
        if (opts.cache) opts.cache.entry = { key, validation };
      }
    } finally {
      closeSync(fd);
    }
    if (!validation.ok) {
      return deny(`${at}: invalid: ${validation.errors.join("; ")}`);
    }
    const { registration } = validation;

    const envErrors = runEnvErrors(env, registration);
    if (envErrors.length > 0) {
      return deny(`run variables: ${envErrors.join("; ")}`);
    }

    let checker: string | undefined;
    const rawChecker = registration.result?.checker;
    if (rawChecker !== undefined) {
      const c = vetTrustedFile(rawChecker, ".mjs", vetOpts);
      if (!("path" in c)) {
        return deny(
          `result.checker ${rawPath(rawChecker)} (GUARD_RUN_MANIFEST): ${c.why}`,
        );
      }
      checker = c.path;
    }

    if (opts.dataDir && opts.sessionId) {
      const rawMode = env.GUARD_RUN_MODE ?? "";
      const vars = {
        run_id: env.GUARD_RUN_ID ?? "",
        mode: rawMode === "" ? "unattended" : rawMode,
        ticket: env.GUARD_RUN_TICKET ?? "",
      };
      const file = pinFile(opts.dataDir, opts.sessionId);
      const read = (): { pin?: Pin; why?: string } => {
        try {
          return { pin: firstPin(readFileSync(file, "utf8")) };
        } catch (e: unknown) {
          const code = codeOf(e);
          return code === "ENOENT"
            ? {}
            : { why: `cannot read the session's registration pin (${code})` };
        }
      };
      let r = read();
      if (r.why) return deny(r.why);
      if (!r.pin) {
        try {
          mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
          appendFileSync(
            file,
            `${JSON.stringify({ manifest: real, sha256, ...vars })}\n`,
          );
        } catch (e: unknown) {
          return deny(`cannot pin the registration (${codeOf(e)})`);
        }
        // a parallel hook may have pinned first: the first valid line wins
        r = read();
        if (r.why) return deny(r.why);
        if (!r.pin) return deny("cannot pin the registration (missing)");
      }
      if (r.pin.manifest !== real) {
        return deny(
          "GUARD_RUN_MANIFEST names more than one path (another manifest is pinned for this session)",
        );
      }
      if (r.pin.sha256 !== sha256) {
        return deny(
          `manifest changed during the session (sha256 ${r.pin.sha256.slice(0, 16)}… was pinned)`,
        );
      }
      const changed = (["run_id", "mode", "ticket"] as const).filter(
        (k) => r.pin?.[k] !== vars[k],
      );
      if (changed.length > 0) {
        return deny(
          `run variables changed during the session (${changed.map((k) => `GUARD_RUN_${k === "run_id" ? "ID" : k.toUpperCase()}`).join(", ")})`,
        );
      }
    }

    return {
      state: "registered",
      registration,
      path: real,
      sha256,
      ...(checker === undefined ? {} : { checker }),
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return deny(`cannot be checked (${scrub(msg).slice(0, 100)})`);
  }
}
