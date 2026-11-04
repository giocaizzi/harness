// Run contract v2: the runner's registration manifest (GUARD_RUN_MANIFEST). Pure: no fs or process I/O. The schema is
// strict (unknown keys, unknown capabilities and another contract major are refused), and a registration can only add
// protection on top of guard's built-in floor, never remove or loosen it. Not wired into decisions yet: contract v1
// stays the enforced contract until guard 1.0.0.

import { DEFAULT_PROTECTED_LIMITS } from "./constants.mjs";
import type { ProtectedLimits } from "./types.mjs";

export const CONTRACT = 2;

// The capabilities a registration may require, sorted. A required capability guard does not know is refused.
export const CAPABILITIES = [
  "events",
  "gh-visibility",
  "labels",
  "modes",
  "protected-paths",
  "result-gate",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const MODES = ["attended", "unattended"] as const;
export type Mode = (typeof MODES)[number];

// The rule every registration failure denies with, and the legacy-only tripwire's rule.
export const RULE = "run-registration";
export const UNREGISTERED_RULE = "run-unregistered";

export const MAX_MANIFEST_BYTES = 64 * 1024;

export const RUNNER = /^[a-z0-9-]{1,40}$/;
export const LABEL = /^[\w.:-]{1,50}$/;

export interface Registration {
  contract: typeof CONTRACT;
  labels?: { approval?: string; protected?: string[]; takeover?: string };
  modes?: Mode[];
  protected_paths?: { exempt?: string[]; globs?: string[] };
  requires: Capability[];
  result?: { checker?: string; file: string; hint?: string };
  runner: string;
}

export type Validation =
  { ok: true; registration: Registration } | { errors: string[]; ok: false };

// Checks a parsed manifest against the schema: { ok, registration } or { ok: false, errors } (every error found,
// capped by core/result.mjs's report()). Never throws.
export function validateRegistration(
  value: unknown,
  limits: ProtectedLimits = DEFAULT_PROTECTED_LIMITS,
): Validation {
  throw new Error("not implemented");
}

// The manifest's bytes to a Validation: at most MAX_MANIFEST_BYTES, strict UTF-8 without a BOM, one JSON value.
// Never throws.
export function parseRegistration(
  bytes: Uint8Array,
  limits: ProtectedLimits = DEFAULT_PROTECTED_LIMITS,
): Validation {
  throw new Error("not implemented");
}

// Expands result.file's {ticket_number} and {run_id}: { path } (repo-relative, POSIX separators) or { why }.
export function resultFile(
  template: string,
  vars: { run_id: string; ticket_number: string },
): { path: string } | { why: string } {
  throw new Error("not implemented");
}

// Errors in the run's GUARD_RUN_* variables against a valid registration (GUARD_RUN_ID, GUARD_RUN_MODE,
// GUARD_RUN_TICKET). Never throws.
export function runEnvErrors(
  env: Readonly<Record<string, string | undefined>>,
  registration: Registration,
): string[] {
  throw new Error("not implemented");
}

// The legacy-only tripwire's events line: {ts, event, decision, rule, reason}, no paths and no env values.
export function unregisteredLine(reason: string, ts?: string): string {
  throw new Error("not implemented");
}

// The secret-free guard.session attributes for a run: run.registered, and for a registered run runner.name,
// runner.contract and runner.manifest_sha16 (the first 16 hex characters of the manifest's sha256).
export function sessionAttrs(
  registered: { registration: Registration; sha256: string } | null,
): Record<string, boolean | number | string> {
  throw new Error("not implemented");
}
