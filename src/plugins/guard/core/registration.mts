// Run contract v2: the runner's registration manifest (GUARD_RUN_MANIFEST). Pure: no fs or process I/O. The schema is
// strict (unknown keys, unknown capabilities and another contract major are refused), and a registration can only add
// protection on top of guard's built-in floor, never remove or loosen it. Enforced from guard 1.0.0.

import path from "node:path";

import { DEFAULT_PROTECTED_LIMITS } from "./constants.mjs";
import { checkerPathError, report, show, TICKET } from "./result.mjs";
import { rules } from "./rules.mjs";
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
export const RUN_ID = /^[A-Za-z0-9_][\w.-]{0,99}$/;

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

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// Own keys only, so nothing is read through the prototype.
const get = (o: Obj, k: string): unknown =>
  Object.hasOwn(o, k) ? o[k] : undefined;

const isStr = (v: unknown): v is string => typeof v === "string";

const CONTROL = /[\u0000-\u001f\u007f]/;

// C1 controls (NEL included), line separators and bidi controls, which can disguise text in a hint.
const BIDI =
  /[\u0080-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

// Why a repo-relative path or glob is not acceptable, or null: 1..max characters, no control character, no
// backslash, not absolute, no empty, "." or ".." segment.
const pathRuleError = (v: string, max: number): string | null => {
  if (v.length < 1 || v.length > max) {
    return `must be 1 to ${String(max)} characters`;
  }
  if (CONTROL.test(v)) return "must not contain control characters";
  if (v.includes("\\")) return "must not contain a backslash";
  if (v.startsWith("/") || /^[A-Za-z]:/.test(v)) return "must not be absolute";
  if (v.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) {
    return 'must not have an empty, "." or ".." segment';
  }
  return null;
};

// An array of strings (at most `max` entries): a copy, or null after pushing the error.
const strings = (
  v: unknown,
  key: string,
  errors: string[],
  max = Infinity,
): string[] | null => {
  if (!Array.isArray(v)) {
    errors.push(`${key} must be an array of strings, got ${show(v)}`);
    return null;
  }
  if (v.length > max) {
    errors.push(
      `${key} must have at most ${String(max)} entries, got ${String(v.length)}`,
    );
    return null;
  }
  const bad = v.findIndex((e) => !isStr(e));
  if (bad >= 0) {
    errors.push(`${key}[${String(bad)}] must be a string, got ${show(v[bad])}`);
    return null;
  }
  return [...(v as string[])];
};

const unknownKeys = (
  o: Obj,
  allowed: readonly string[],
  key: string,
  errors: string[],
) => {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) {
      errors.push(`${key ? `${key}: ` : ""}unknown key ${show(k)}`);
    }
  }
};

const dupes = (list: string[], key: string, errors: string[]) => {
  const seen = new Set<string>();
  for (const e of list) {
    if (seen.has(e)) errors.push(`${key}: duplicate entry ${show(e)}`);
    seen.add(e);
  }
};

const checkLabels = (v: unknown, errors: string[]): Registration["labels"] => {
  if (!isObj(v)) {
    errors.push(`labels must be an object, got ${show(v)}`);
    return undefined;
  }
  unknownKeys(v, ["approval", "protected", "takeover"], "labels", errors);
  const out: NonNullable<Registration["labels"]> = {};
  for (const k of ["approval", "takeover"] as const) {
    const x = get(v, k);
    if (x === undefined) continue;
    if (isStr(x) && LABEL.test(x)) out[k] = x;
    else errors.push(`labels.${k} must match ${String(LABEL)}, got ${show(x)}`);
  }
  const prot = get(v, "protected");
  if (prot !== undefined) {
    const list = strings(prot, "labels.protected", errors, 32);
    if (list) {
      const bad = list.findIndex((e) => !LABEL.test(e));
      if (bad >= 0) {
        errors.push(
          `labels.protected[${String(bad)}] must match ${String(LABEL)}, got ${show(list[bad])}`,
        );
      } else {
        dupes(list, "labels.protected", errors);
        out.protected = list;
      }
    }
  }
  return out;
};

// A result file never lands in git's own directory or in .github.
const GIT_DIR = /^\.git(hub)?$/i;

const GLOB_CHARS = /[*?[\]{}!]/;

const checkProtected = (
  v: unknown,
  limits: ProtectedLimits,
  errors: string[],
): Registration["protected_paths"] => {
  if (!isObj(v)) {
    errors.push(`protected_paths must be an object, got ${show(v)}`);
    return undefined;
  }
  unknownKeys(v, ["exempt", "globs"], "protected_paths", errors);
  const out: NonNullable<Registration["protected_paths"]> = {};
  const g = get(v, "globs");
  const x = get(v, "exempt");
  const globs =
    g === undefined ? null : strings(g, "protected_paths.globs", errors);
  const exempt =
    x === undefined ? null : strings(x, "protected_paths.exempt", errors);
  const total = (globs?.length ?? 0) + (exempt?.length ?? 0);
  if (total > limits.globs) {
    errors.push(
      `protected_paths must have at most ${String(limits.globs)} globs and exempt entries together, got ${String(total)}`,
    );
    return out;
  }
  for (const [list, key] of [
    [globs, "globs"],
    [exempt, "exempt"],
  ] as const) {
    list?.forEach((e, i) => {
      const why = pathRuleError(e, limits.chars);
      if (why) {
        errors.push(
          `protected_paths.${key}[${String(i)}] ${why}, got ${show(e)}`,
        );
      }
    });
  }
  if (globs) out.globs = globs;
  if (exempt) {
    // Exemptions apply only to this registration's own globs: never under .github or a built-in protected default.
    const floor = new Set([
      ".github",
      ...rules.run.protectedPaths.map((g) =>
        (g.split("/")[0] ?? "").toLowerCase(),
      ),
    ]);
    const firsts = new Set((globs ?? []).map((e) => e.split("/")[0]));
    exempt.forEach((e, i) => {
      const first = e.split("/")[0] ?? "";
      if (
        GLOB_CHARS.test(first) ||
        floor.has(first.toLowerCase()) ||
        !firsts.has(first)
      ) {
        errors.push(
          `protected_paths.exempt[${String(i)}]: may only narrow this registration's own globs, never the built-in floor, got ${show(e)}`,
        );
      }
    });
    out.exempt = exempt;
  }
  return out;
};

const checkResult = (
  v: unknown,
  limits: ProtectedLimits,
  pathApi: typeof path,
  errors: string[],
): Registration["result"] => {
  if (!isObj(v)) {
    errors.push(`result must be an object, got ${show(v)}`);
    return undefined;
  }
  unknownKeys(v, ["checker", "file", "hint"], "result", errors);
  const out: Partial<NonNullable<Registration["result"]>> = {};
  const file = get(v, "file");
  if (!isStr(file)) {
    errors.push(`result.file must be a string, got ${show(file)}`);
  } else {
    const why = pathRuleError(file, limits.chars);
    const bare = file
      .replaceAll("{ticket_number}", "")
      .replaceAll("{run_id}", "");
    if (why) errors.push(`result.file ${why}, got ${show(file)}`);
    else if ((file.split("/")[0] ?? "").includes("{")) {
      errors.push(
        `result.file must not use a placeholder in its first segment, got ${show(file)}`,
      );
    } else if (GIT_DIR.test(file.split("/")[0] ?? "")) {
      errors.push(
        `result.file must not be under .git or .github, got ${show(file)}`,
      );
    } else if (/[*?[\]!]/.test(file)) {
      errors.push(
        `result.file must not contain glob characters, got ${show(file)}`,
      );
    } else if (/[{}]/.test(bare)) {
      errors.push(
        `result.file may only use the placeholders {ticket_number} and {run_id}, got ${show(file)}`,
      );
    } else if (!file.endsWith(".json")) {
      errors.push(`result.file must end with .json, got ${show(file)}`);
    } else out.file = file;
  }
  const checker = get(v, "checker");
  if (checker !== undefined) {
    if (!isStr(checker)) {
      errors.push(`result.checker must be a string, got ${show(checker)}`);
    } else if (checker !== checker.trim()) {
      errors.push(
        `result.checker must not have leading or trailing whitespace, got ${show(checker)}`,
      );
    } else {
      const why = checkerPathError(checker.trim(), pathApi);
      if (why) errors.push(`result.checker: ${why}, got ${show(checker)}`);
      else out.checker = checker;
    }
  }
  const hint = get(v, "hint");
  if (hint !== undefined) {
    if (
      !isStr(hint) ||
      hint.length < 1 ||
      hint.length > 500 ||
      CONTROL.test(hint) ||
      BIDI.test(hint)
    ) {
      errors.push(
        `result.hint must be 1 to 500 characters without control, bidi or line-separator characters, got ${show(hint)}`,
      );
    } else out.hint = hint;
  }
  return out as Registration["result"];
};

const checkModes = (v: unknown, errors: string[]): Mode[] | undefined => {
  const modes = strings(v, "modes", errors);
  if (!modes) return undefined;
  if (modes.length < 1 || modes.length > MODES.length) {
    errors.push(
      `modes must have 1 to ${String(MODES.length)} entries, got ${show(modes)}`,
    );
    return undefined;
  }
  for (const m of modes) {
    if (!(MODES as readonly string[]).includes(m)) {
      errors.push(`modes: unknown mode ${show(m)}`);
    }
  }
  dupes(modes, "modes", errors);
  return modes as Mode[];
};

const checkRegistration = (
  value: unknown,
  limits: ProtectedLimits,
  pathApi: typeof path,
  errors: string[],
): Registration | null => {
  if (!isObj(value)) {
    errors.push(`manifest must be a JSON object, got ${show(value)}`);
    return null;
  }
  unknownKeys(
    value,
    [
      "contract",
      "runner",
      "requires",
      "labels",
      "protected_paths",
      "result",
      "modes",
    ],
    "",
    errors,
  );
  const contract = get(value, "contract");
  if (contract !== CONTRACT) {
    errors.push(
      `contract must be ${String(CONTRACT)} (this guard speaks run contract ${String(CONTRACT)}), got ${show(contract)}`,
    );
  }
  const runner = get(value, "runner");
  if (!isStr(runner) || !RUNNER.test(runner)) {
    errors.push(`runner must match ${String(RUNNER)}, got ${show(runner)}`);
  }
  let requires: Capability[] = [];
  const req = strings(get(value, "requires"), "requires", errors, 16);
  if (req) {
    for (const c of req) {
      if (!(CAPABILITIES as readonly string[]).includes(c)) {
        errors.push(`requires: unknown capability ${show(c)}`);
      }
    }
    dupes(req, "requires", errors);
    requires = req as Capability[];
  }
  const out: Registration = {
    contract: CONTRACT,
    runner: isStr(runner) ? runner : "",
    requires,
  };
  const has = (k: string) => get(value, k) !== undefined;
  if (has("labels")) {
    const labels = checkLabels(get(value, "labels"), errors);
    if (labels) out.labels = labels;
  }
  if (has("protected_paths")) {
    const pp = checkProtected(get(value, "protected_paths"), limits, errors);
    if (pp) out.protected_paths = pp;
  }
  if (has("result")) {
    const result = checkResult(get(value, "result"), limits, pathApi, errors);
    if (result) out.result = result;
  }
  if (has("modes")) {
    const modes = checkModes(get(value, "modes"), errors);
    if (modes) out.modes = modes;
  }
  for (const [key, cap] of [
    ["labels", "labels"],
    ["protected_paths", "protected-paths"],
    ["result", "result-gate"],
    ["modes", "modes"],
  ] as const) {
    if (has(key) && !requires.includes(cap)) {
      errors.push(`${key} is set but requires does not list ${show(cap)}`);
    }
  }
  if (requires.includes("result-gate") && !has("result")) {
    errors.push('requires lists "result-gate" but result is not set');
  }
  return out;
};

const failure = (e: unknown): string =>
  `cannot be checked (${e instanceof Error ? e.message : show(e)})`;

// Checks a parsed manifest against the schema: { ok, registration } (a fresh object of validated fields only) or
// { ok: false, errors } (every error found, capped by core/result.mjs's report()). `pathApi` selects the checker
// path rules (path.win32 on Windows). Never throws.
export function validateRegistration(
  value: unknown,
  limits: ProtectedLimits = DEFAULT_PROTECTED_LIMITS,
  pathApi: typeof path = path,
): Validation {
  const errors: string[] = [];
  try {
    const registration = checkRegistration(value, limits, pathApi, errors);
    if (errors.length === 0 && registration) return { ok: true, registration };
  } catch (e) {
    errors.push(failure(e));
  }
  return { ok: false, errors: report(errors) };
}

// The manifest's bytes to a Validation: at most MAX_MANIFEST_BYTES, strict UTF-8 without a BOM, one JSON value.
// Never throws.
export function parseRegistration(
  bytes: Uint8Array,
  limits: ProtectedLimits = DEFAULT_PROTECTED_LIMITS,
  pathApi: typeof path = path,
): Validation {
  const fail = (why: string): Validation => ({ ok: false, errors: [why] });
  try {
    if (bytes.length > MAX_MANIFEST_BYTES) {
      return fail("too large (over 64 KiB)");
    }
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return fail("starts with a byte order mark");
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes,
      );
    } catch {
      return fail("not valid UTF-8");
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return fail(`not valid JSON (${msg.slice(0, 100)})`);
    }
    return validateRegistration(value, limits, pathApi);
  } catch (e) {
    return fail(failure(e));
  }
}

// Expands result.file's {ticket_number} and {run_id}: { path } (repo-relative, POSIX separators) or { why }. A
// variable is checked only when the template uses it.
export function resultFile(
  template: string,
  vars: { run_id: string; ticket_number?: string },
): { path: string } | { why: string } {
  const ticketNumber = vars.ticket_number ?? "";
  if (
    template.includes("{ticket_number}") &&
    !/^[1-9]\d{0,9}$/.test(ticketNumber)
  ) {
    return {
      why: `ticket number must match ^[1-9]\\d{0,9}$, got ${show(vars.ticket_number)}`,
    };
  }
  if (template.includes("{run_id}") && !RUN_ID.test(vars.run_id)) {
    return {
      why: `run id must match ${RUN_ID.source}, got ${show(vars.run_id)}`,
    };
  }
  const expanded = template
    .replaceAll("{ticket_number}", ticketNumber)
    .replaceAll("{run_id}", vars.run_id);
  const why = pathRuleError(expanded, DEFAULT_PROTECTED_LIMITS.chars);
  if (why) return { why: `result file ${why}, got ${show(expanded)}` };
  if (GIT_DIR.test(expanded.split("/")[0] ?? "")) {
    return {
      why: `result file must not be under .git or .github, got ${show(expanded)}`,
    };
  }
  return { path: expanded };
}

// Errors in the run's GUARD_RUN_* variables against a valid registration (GUARD_RUN_ID, GUARD_RUN_MODE,
// GUARD_RUN_TICKET), each checked as-is (no trimming; unset or "" mode means unattended, unset or "" ticket means
// unset). Never throws.
export function runEnvErrors(
  env: Readonly<Record<string, string | undefined>>,
  registration: Registration,
): string[] {
  const errors: string[] = [];
  try {
    if (!RUN_ID.test(env.GUARD_RUN_ID ?? "")) {
      errors.push(
        `GUARD_RUN_ID must match ${RUN_ID.source}, got ${show(env.GUARD_RUN_ID)}`,
      );
    }
    const raw = env.GUARD_RUN_MODE ?? "";
    const mode = raw === "" ? "unattended" : raw;
    const allowed: readonly string[] = registration.modes ?? MODES;
    if (
      !(MODES as readonly string[]).includes(mode) ||
      !allowed.includes(mode)
    ) {
      errors.push(
        `GUARD_RUN_MODE ${show(mode)} is not one of the registration's modes ${show(allowed)}`,
      );
    }
    const ticket = env.GUARD_RUN_TICKET;
    if (ticket !== undefined && ticket !== "") {
      if (!TICKET.test(ticket)) {
        errors.push(
          `GUARD_RUN_TICKET must match ${String(TICKET)}, got ${show(ticket)}`,
        );
      }
    } else if (registration.result?.file.includes("{ticket_number}")) {
      errors.push("GUARD_RUN_TICKET is required by result.file");
    }
  } catch (e) {
    errors.push(failure(e));
  }
  return errors;
}

// The reason the legacy-only tripwire denies with.
export const UNREGISTERED_REASON =
  "legacy run variables are set without a run registration";

// The legacy-only tripwire's events line: {ts, event, decision, rule, reason}, no paths and no env values.
export function unregisteredLine(
  ts: string = new Date().toISOString(),
): string {
  return JSON.stringify({
    ts,
    event: "run-unregistered",
    decision: "deny",
    rule: UNREGISTERED_RULE,
    reason: UNREGISTERED_REASON,
  });
}

// The secret-free guard.session attributes for a run: run.registered, and for a registered run runner.name,
// runner.contract and runner.manifest_sha16 (the first 16 hex characters of the manifest's sha256).
export function sessionAttrs(
  registered: { registration: Registration; sha256: string } | null,
): Record<string, boolean | number | string> {
  if (!registered) return { "run.registered": false };
  const attrs: Record<string, boolean | number | string> = {
    "run.registered": true,
    "runner.name": registered.registration.runner,
    "runner.contract": CONTRACT,
  };
  if (/^[0-9a-f]{64}$/.test(registered.sha256)) {
    attrs["runner.manifest_sha16"] = registered.sha256.slice(0, 16);
  }
  return attrs;
}
