// Run contract v2: loads the runner's registration from GUARD_RUN_MANIFEST, read on every hook call. The manifest
// (and its result.checker) must be out of this user's reach, as the result checker is (hooks/checker.mjs), and its
// realpath and sha256 are pinned in the session's state on first sight: a later change denies. Not wired into
// decisions yet: contract v1 stays the enforced contract until guard 1.0.0.

import type { Registration } from "../core/registration.mjs";
import type { PrepareOptions } from "./checker.mjs";

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

// In-process harnesses (opencode, pi) keep one per process: the parsed manifest is reused while realpath, inode,
// mtime and size are unchanged, and the trust checks and the pin still run on every call.
export interface RegistrationCache {
  clear(): void;
}

export interface LoadOptions {
  cache?: RegistrationCache;
  dataDir?: string;
  sessionId?: string;
  vet?: PrepareOptions;
}

export function createRegistrationCache(): RegistrationCache {
  throw new Error("not implemented");
}

// The session's pin file: <dataDir>/sessions/<session id>.run.jsonl, next to its facts file.
export function pinFile(dataDir: string, sessionId: string): string {
  throw new Error("not implemented");
}

// The registration for this hook call: none (no GUARD_RUN_* variable), registered, or a deny with rule
// run-registration. Never throws.
export function loadRegistration(
  env: Readonly<Record<string, string | undefined>>,
  opts: LoadOptions = {},
): Loaded {
  throw new Error("not implemented");
}
