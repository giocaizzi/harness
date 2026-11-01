// Checks a run's result.json: the core fields (`schema`, `ticket`, `run_id`, `end_state`, `reason`, `reason_code`),
// `finished_at` and `phases` times, the optional `routing` entries and `mode` (only `dev`),
// `tasks` (a group run's members, schema 3, and the highest `end_state` they allow; with FACTORY_RUN_FILE set, a result
// needs them, a stop at the gate aside, and their tickets are the run file's members) and a change run's `change`.
// Usage `node check-result.mjs <result.json>`: exit 0 valid, 1 invalid or unreadable (one line per error), 2 usage.
// A deviation (model or effort differing from the policy's) needs a non-empty deviation_reason; a time the run could not
// find is null, never a dropped key. Imports Node built-ins only, so a hook can copy it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { EnvMap } from "./types.mjs";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const parseJson = (text: string): unknown => JSON.parse(text);

const errCode = (e: unknown): string | undefined =>
  isRecord(e) && typeof e.code === "string" ? e.code : undefined;

const errMsg = (e: unknown): string =>
  e instanceof Error
    ? e.message
    : isRecord(e) && typeof e.message === "string"
      ? e.message
      : typeof e;

/** Formats a value for error messages, capped at 200 characters. */
export const show = (v: unknown): string => {
  const text = typeof v === "undefined" ? "undefined" : JSON.stringify(v);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
};

const MAX_LINE = 300;
const MAX_LINES = 50;

/** Formats and caps an error list to at most 50 lines of 300 characters each. */
export const report = (errors: readonly string[]): string[] => {
  const lines = errors
    .slice(0, MAX_LINES)
    .map((e) => (e.length > MAX_LINE ? `${e.slice(0, MAX_LINE)}…` : e));
  return errors.length > MAX_LINES
    ? [...lines, `… and ${String(errors.length - MAX_LINES)} more`]
    : lines;
};

const fields = ["phase", "policy_model", "policy_effort", "model", "effort"];

const STEPS = ["gate", "plan", "work", "verify", "ship", "deploy", "record"];
const ISO =
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

// Date.parse rolls an impossible day over (2026-02-30 → 03-02): the date must round-trip unchanged.
const isTime = (v: unknown): v is string =>
  typeof v === "string" &&
  ISO.test(v) &&
  !Number.isNaN(Date.parse(v)) &&
  new Date(`${v.slice(0, 10)}T00:00:00Z`)
    .toISOString()
    .startsWith(v.slice(0, 10));

/** Validates `finished_at` and the `phases` array on a result object. */
export const timeErrors = (result: Record<string, unknown>): string[] => {
  const errors = isTime(result.finished_at)
    ? []
    : ["finished_at must be an ISO 8601 time"];
  if (!Array.isArray(result.phases) || result.phases.length === 0) {
    return [...errors, "phases must list every step the run reached"];
  }
  let last = -1;
  result.phases.forEach((p: unknown, i: number) => {
    const at = `phases[${String(i)}]`;
    if (!isRecord(p)) {
      errors.push(
        `${at}: must be an object with name, started_at and ended_at`,
      );
      return;
    }
    const step = typeof p.name === "string" ? STEPS.indexOf(p.name) : -1;
    if (step <= last) {
      errors.push(
        `${at}: name must be one of ${STEPS.join(", ")}, in that order, each once`,
      );
    }
    last = Math.max(last, step);
    for (const key of ["started_at", "ended_at"]) {
      if (!(key in p))
        errors.push(`${at}: ${key} missing (write null when unknown)`);
      else if (p[key] !== null && !isTime(p[key])) {
        errors.push(`${at}: ${key} must be an ISO 8601 time or null`);
      }
    }
    if (
      isTime(p.started_at) &&
      isTime(p.ended_at) &&
      Date.parse(p.ended_at) < Date.parse(p.started_at)
    ) {
      errors.push(`${at}: ended_at is before started_at`);
    }
  });
  return errors;
};

export const TICKET = /^[\w.-]+\/[\w.-]+#[1-9]\d*$/;

/** Validates `ticket` against the `<owner>/<repo>#<number>` format and `FACTORY_TICKET`. */
export const ticketErrors = (
  result: Record<string, unknown>,
  expected: string | undefined = process.env.FACTORY_TICKET,
): string[] => {
  if (typeof result.ticket !== "string" || !TICKET.test(result.ticket)) {
    return [
      `ticket must be a string of the form "<owner>/<repo>#<number>", got ${show(result.ticket)}`,
    ];
  }
  const want = (expected ?? "").trim();
  return want && result.ticket !== want
    ? [
        `ticket ${show(result.ticket)} differs from FACTORY_TICKET ${show(want)}`,
      ]
    : [];
};

/** Returns true when the run stopped at the gate (never `done`, and `phases` has only `gate`). */
export const isGateStop = (result: Record<string, unknown>): boolean => {
  if (
    result.end_state === "done" ||
    !Array.isArray(result.phases) ||
    result.phases.length !== 1
  ) {
    return false;
  }
  const first: unknown = result.phases[0];
  return isRecord(first) && first.name === "gate";
};

/** Validates the optional `mode` field on a result object. */
export const modeErrors = (result: Record<string, unknown>): string[] =>
  result.mode === undefined || result.mode === "dev"
    ? []
    : ['mode must be "dev" or absent'];

export const CHANGE_TRIGGERS = ["changes_requested", "mention", "check_failed"];
const CHANGE_KEYS = [
  "issues",
  "trigger",
  "attempt",
  "max_attempts",
  "sources",
  "head",
  "pushed",
];
const SHA = /^[0-9a-f]{40}$/;
const PULL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)$/;

const matchesTicketPr = (ticket: unknown, pr: unknown): boolean => {
  const t =
    typeof ticket === "string"
      ? /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(ticket)
      : null;
  const q = typeof pr === "string" ? PULL.exec(pr) : null;
  return (
    t?.[1] !== undefined &&
    t[2] !== undefined &&
    t[3] !== undefined &&
    q?.[1] !== undefined &&
    q[2] !== undefined &&
    q[3] !== undefined &&
    q[1].toLowerCase() === t[1].toLowerCase() &&
    q[2].toLowerCase() === t[2].toLowerCase() &&
    q[3] === t[3]
  );
};

/** Validates a change run's `change` object and its invariants with the rest of the result. */
export const changeErrors = (result: Record<string, unknown>): string[] => {
  const change = result.change;
  if (change === undefined || change === null) {
    const errors =
      result.reason_code === "fix_attempts"
        ? ["change: reason_code fix_attempts needs change"]
        : [];
    // Issues and PRs share one number space: an issue run's PR never has the ticket's number.
    // A stop at the gate wrote no unit, so it carries no change.
    if (!isGateStop(result) && matchesTicketPr(result.ticket, result.pr)) {
      errors.push(
        "change: pr is the ticket itself, so this is a change run and needs change",
      );
    }
    return errors;
  }
  if (!isRecord(change))
    return [`change: must be an object or null, got ${show(change)}`];
  const errors: string[] = [];
  for (const key of CHANGE_KEYS)
    if (!(key in change)) errors.push(`change.${key}: missing`);
  for (const key of Object.keys(change)) {
    if (!CHANGE_KEYS.includes(key))
      errors.push(`change.${show(key)}: unknown key`);
  }
  if ("tasks" in result) errors.push("change: a change run has no tasks");
  const {
    issues,
    trigger,
    attempt,
    max_attempts: max,
    sources,
    head,
    pushed,
  } = change;
  const isList = (v: unknown): v is unknown[] =>
    Array.isArray(v) && new Set(v).size === v.length;
  if (
    !isList(issues) ||
    issues.length === 0 ||
    !issues.every(
      (i): i is string => typeof i === "string" && TICKET.test(i),
    ) ||
    new Set(issues.map((i) => i.toLowerCase())).size !== issues.length
  ) {
    errors.push(
      `change.issues: must be a non-empty array of unique <owner>/<repo>#<number>, got ${show(issues)}`,
    );
  } else if (
    typeof result.ticket === "string" &&
    issues.map((i) => i.toLowerCase()).includes(result.ticket.toLowerCase())
  ) {
    errors.push(
      `change.issues: must not include the change ${show(result.ticket)}`,
    );
  }
  if (typeof trigger !== "string" || !CHANGE_TRIGGERS.includes(trigger)) {
    errors.push(
      `change.trigger: must be one of ${CHANGE_TRIGGERS.join(", ")}, got ${show(trigger)}`,
    );
  }
  const isInt = (v: unknown): v is number =>
    typeof v === "number" && Number.isInteger(v) && v >= 1;
  if (!isInt(max)) {
    errors.push(
      `change.max_attempts: must be an integer of at least 1, got ${show(max)}`,
    );
  }
  if (!isInt(attempt)) {
    errors.push(
      `change.attempt: must be an integer of at least 1, got ${show(attempt)}`,
    );
  }
  if (
    !isList(sources) ||
    sources.length < 1 ||
    sources.length > 50 ||
    !sources.every(
      (s): s is string => typeof s === "string" && s.startsWith("https://"),
    )
  ) {
    errors.push(
      `change.sources: must be 1 to 50 unique https:// URLs, got ${show(sources)}`,
    );
  }
  if (typeof head !== "string" || !SHA.test(head)) {
    errors.push(`change.head: must be 40 lowercase hex, got ${show(head)}`);
  }
  if (pushed !== null && (typeof pushed !== "string" || !SHA.test(pushed))) {
    errors.push(
      `change.pushed: must be 40 lowercase hex or null, got ${show(pushed)}`,
    );
  }
  if (!matchesTicketPr(result.ticket, result.pr)) {
    errors.push(
      `change: pr must be the change's URL https://github.com/<owner>/<repo>/pull/<number> for ticket ${show(result.ticket)}, got ${show(result.pr)}`,
    );
  }
  if (isInt(attempt) && isInt(max)) {
    if (result.reason_code === "fix_attempts") {
      if (result.end_state !== "parked") {
        errors.push(
          `change: reason_code fix_attempts needs end_state parked, got ${show(result.end_state)}`,
        );
      }
      if (attempt !== max + 1) {
        errors.push(
          `change.attempt: must be max_attempts + 1 (${String(max + 1)}) for fix_attempts, got ${show(attempt)}`,
        );
      }
      if (pushed !== null) {
        errors.push(
          `change.pushed: must be null for fix_attempts, got ${show(pushed)}`,
        );
      }
    } else if (attempt > max) {
      errors.push(
        `change.attempt: ${String(attempt)} is over max_attempts ${String(max)}`,
      );
    }
  }
  if (
    result.end_state === "done" &&
    (pushed === null || pushed === undefined || pushed === head)
  ) {
    errors.push(
      "change.pushed: end_state done needs a pushed commit different from head",
    );
  }
  return errors;
};

/** Validates the optional `routing` array on a result object. */
export const routingErrors = (result: Record<string, unknown>): string[] => {
  if (result.routing === undefined) return [];
  if (!Array.isArray(result.routing)) return ["routing must be an array"];
  return result.routing.flatMap((entry: unknown, i: number) => {
    const at = `routing[${String(i)}]`;
    const rec = isRecord(entry) ? entry : null;
    const missing = fields.filter(
      (f) => typeof rec?.[f] !== "string" || rec[f] === "",
    );
    if (!rec || missing.length) return [`${at}: missing ${missing.join(", ")}`];
    const reason = rec.deviation_reason;
    const deviates =
      rec.model !== rec.policy_model || rec.effort !== rec.policy_effort;
    if (deviates && (typeof reason !== "string" || reason.trim() === "")) {
      return [
        `${at} (${show(rec.phase)}): deviates from the policy without a deviation_reason`,
      ];
    }
    if (reason !== null && reason !== undefined && typeof reason !== "string") {
      return [`${at}: deviation_reason must be a string or null`];
    }
    return [];
  });
};

export const END_STATES = [
  "done",
  "parked",
  "failed",
  "budget_reached",
  "halted",
];
export const REASON_CODES = [
  "question",
  "plan_gate",
  "merge_gate",
  "grooming",
  "verify_rounds",
  "live_verify_failed",
  "env_blocked",
  "budget",
  "auth",
  "fix_attempts",
  "handoff",
  "takeover",
];
export const OUTCOMES = ["done", "parked", "released"];
export const PR_LINKS = ["closes", "refs"];

/** Validates core result fields (`schema`, `run_id`, `end_state`, `reason`, `reason_code`). */
export const coreErrors = (
  result: Record<string, unknown>,
  env: EnvMap = process.env,
): string[] => {
  const errors: string[] = [];
  if (result.schema !== 2 && result.schema !== 3) {
    errors.push(
      `schema must be 2, or 3 with tasks, got ${show(result.schema)}`,
    );
  }
  const want = (env.FACTORY_RUN_ID ?? "").trim();
  if (typeof result.run_id !== "string" || result.run_id.trim() === "") {
    errors.push(
      `run_id must be a non-empty string, got ${show(result.run_id)}`,
    );
  } else if (want && result.run_id !== want) {
    errors.push(
      `run_id ${show(result.run_id)} differs from FACTORY_RUN_ID ${show(want)}`,
    );
  }
  if (
    typeof result.end_state !== "string" ||
    !END_STATES.includes(result.end_state)
  ) {
    errors.push(
      `end_state must be one of ${END_STATES.join(", ")}, got ${show(result.end_state)}`,
    );
  }
  if (typeof result.reason !== "string") {
    errors.push(
      `reason must be a string (empty when done), got ${show(result.reason)}`,
    );
  }
  if (
    result.reason_code !== null &&
    (typeof result.reason_code !== "string" ||
      !REASON_CODES.includes(result.reason_code))
  ) {
    errors.push(
      `reason_code must be null or one of ${REASON_CODES.join(", ")}, got ${show(result.reason_code)}`,
    );
  } else if (result.reason_code === "handoff") {
    errors.push("reason_code handoff belongs only in a tasks entry");
  }
  return errors;
};

const TASK_KEYS = ["ticket", "outcome", "reason", "reason_code", "pr_link"];

/** Computes the highest `end_state` allowed by a group run's member outcomes. */
export const groupEndState = (
  outcomes: readonly string[],
): "done" | "parked" | "failed" => {
  if (
    outcomes.includes("done") &&
    outcomes.every((o) => o === "done" || o === "released")
  ) {
    return "done";
  }
  return outcomes.includes("parked") ? "parked" : "failed";
};

const isText = (v: unknown): v is string =>
  typeof v === "string" && v.trim() !== "";

/** Validates a group run's `tasks` array and its consistency with the run file and top-level result. */
export const taskErrors = (
  result: Record<string, unknown>,
  env: EnvMap = process.env,
): string[] => {
  const { tasks } = result;
  if (tasks === undefined) {
    if (result.schema === 3) return ["schema 3 needs tasks"];
    // A runtime names a group run's members in the run file: its result lists them, unless the run stopped at the gate,
    // which worked no member and opened nothing.
    const runFile = (env.FACTORY_RUN_FILE ?? "").trim();
    return runFile &&
      !(isGateStop(result) && (result.pr === null || result.pr === undefined))
      ? [
          "tasks: FACTORY_RUN_FILE is set, so this group run's result needs tasks (schema 3); only a stop at the gate, with pr null, leaves them out",
        ]
      : [];
  }
  if (result.schema !== 3) return ["tasks needs schema 3"];
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return [`tasks must be a non-empty array, got ${show(tasks)}`];
  }
  const hasPr = isText(result.pr);
  const seen = new Set<unknown>();
  const errors = tasks.flatMap((t: unknown, i: number) => {
    const at = `tasks[${String(i)}]`;
    if (!isRecord(t))
      return [`${at}: must be an object with ${TASK_KEYS.join(", ")}`];
    const keys = Object.keys(t);
    const off = [
      ...TASK_KEYS.filter((k) => !keys.includes(k)).map((k) => `${k} missing`),
      ...keys
        .filter((k) => k !== "turns" && !TASK_KEYS.includes(k))
        .map((k) => `${show(k)} not allowed`),
    ];
    if (off.length) return [`${at}: ${off.join(", ")}`];
    const e: string[] = [];
    if (typeof t.ticket !== "string" || !TICKET.test(t.ticket)) {
      e.push(
        `${at}: ticket must be "<owner>/<repo>#<number>", got ${show(t.ticket)}`,
      );
    } else if (seen.has(t.ticket)) {
      e.push(`${at}: ticket ${show(t.ticket)} listed twice`);
    }
    seen.add(t.ticket);
    if (i === 0 && t.ticket !== result.ticket) {
      e.push(
        `${at}: the lead ${show(result.ticket)} must come first, got ${show(t.ticket)}`,
      );
    }
    if (
      "turns" in t &&
      !(
        typeof t.turns === "number" &&
        Number.isInteger(t.turns) &&
        t.turns >= 0
      )
    ) {
      e.push(
        `${at}: turns must be a non-negative integer, got ${show(t.turns)}`,
      );
    }
    if (typeof t.outcome !== "string" || !OUTCOMES.includes(t.outcome)) {
      return [
        ...e,
        `${at}: outcome must be one of ${OUTCOMES.join(", ")}, got ${show(t.outcome)}`,
      ];
    }
    const coded =
      typeof t.reason_code === "string" && REASON_CODES.includes(t.reason_code);
    if (t.outcome === "done") {
      if (t.reason !== "")
        e.push(`${at}: reason must be "" when done, got ${show(t.reason)}`);
      if (t.reason_code !== null) {
        e.push(
          `${at}: reason_code must be null when done, got ${show(t.reason_code)}`,
        );
      }
    } else {
      if (!isText(t.reason)) {
        e.push(
          `${at}: reason must be a non-empty string when ${t.outcome}, got ${show(t.reason)}`,
        );
      }
      if (t.outcome === "parked" ? !coded : t.reason_code !== null && !coded) {
        e.push(
          `${at}: reason_code must be ${t.outcome === "parked" ? "" : "null or "}one of ${REASON_CODES.join(", ")} when ${t.outcome}, got ${show(t.reason_code)}`,
        );
      }
    }
    const link =
      !hasPr || t.outcome === "released"
        ? null
        : t.outcome === "done"
          ? "closes"
          : "refs";
    if (t.pr_link !== link) {
      e.push(
        `${at}: pr_link must be ${show(link)} when ${t.outcome}${hasPr ? "" : " without a pr"}, got ${show(t.pr_link)}`,
      );
    }
    return e;
  });
  const done = tasks.some((t: unknown) => isRecord(t) && t.outcome === "done");
  if (!done) {
    if (result.pr !== null && result.pr !== undefined) {
      errors.push("tasks: no done entry, so pr must be null");
    }
    if (result.end_state === "done") {
      errors.push("tasks: no done entry, so end_state must not be done");
    }
    if (!isText(result.reason))
      errors.push("tasks: no done entry, so reason must say why");
  } else if (!hasPr) {
    errors.push("tasks: a done entry needs pr to be a non-empty string");
  }
  // The members bound the run's end_state from above: done needs every member finished, parked needs none only released.
  const outcomes = tasks.map((t: unknown) =>
    isRecord(t) ? t.outcome : undefined,
  );
  if (
    outcomes.every(
      (o): o is string => typeof o === "string" && OUTCOMES.includes(o),
    ) &&
    !(result.end_state === "done" && !done)
  ) {
    const bound = groupEndState(outcomes);
    const rank: Record<string, number> = { done: 2, parked: 1 };
    const stateRank =
      typeof result.end_state === "string" ? (rank[result.end_state] ?? 0) : 0;
    if (stateRank > (rank[bound] ?? 0)) {
      errors.push(
        `tasks: the members' outcomes ${show(outcomes)} allow end_state ${bound} at most, got ${show(result.end_state)}`,
      );
    } else if (
      bound === "done" &&
      result.end_state === "parked" &&
      (typeof result.reason_code !== "string" ||
        !REASON_CODES.includes(result.reason_code))
    ) {
      errors.push(
        `tasks: every member finished, so a parked run needs the reason_code it waits on (such as merge_gate), got ${show(result.reason_code)}`,
      );
    }
  }
  return [...errors, ...runFileErrors(tasks, env)];
};

// With FACTORY_RUN_FILE set, `tasks` lists the run file's members, exactly and in that order; a file that cannot be read fails.
const runFileErrors = (tasks: readonly unknown[], env: EnvMap): string[] => {
  const path = (env.FACTORY_RUN_FILE ?? "").trim();
  if (!path) return [];
  const cannot = (why: string): string[] => [
    `tasks: cannot check against the run file ${show(path)} (${why})`,
  ];
  let parsed: unknown;
  try {
    parsed = parseJson(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch (e: unknown) {
    const code = errCode(e);
    return cannot(
      code === "ENOENT"
        ? "no such file"
        : e instanceof SyntaxError
          ? "not valid JSON"
          : `cannot read (${code ?? errMsg(e)})`,
    );
  }
  const members = isRecord(parsed) ? parsed.members : undefined;
  if (
    !Array.isArray(members) ||
    members.length === 0 ||
    !members.every(
      (m): m is Record<string, unknown> =>
        isRecord(m) && typeof m.ticket === "string",
    )
  ) {
    return cannot("no members list");
  }
  const got = tasks.map((t) => (isRecord(t) ? t.ticket : undefined));
  const want = members.map((m) => m.ticket);
  return got.length === want.length && got.every((g, i) => g === want[i])
    ? []
    : [
        `tasks: tickets ${show(got)} differ from the run file's members ${show(want)}, in that order`,
      ];
};

/** Validates a complete `result.json` value against all contract checks. */
export const resultErrors = (
  result: unknown,
  env: EnvMap = process.env,
): string[] => {
  if (!isRecord(result))
    return [`result.json must hold a JSON object, got ${show(result)}`];
  return [
    ...coreErrors(result, env),
    ...ticketErrors(result, env.FACTORY_TICKET ?? ""),
    ...timeErrors(result),
    ...routingErrors(result),
    ...modeErrors(result),
    ...taskErrors(result, env),
    ...changeErrors(result),
  ];
};

// Exit code, not process.exit: an exit mid-pipe can cut stderr short.
const main = (args: readonly string[]): number => {
  const [file] = args;
  if (!file || args.length > 1) {
    console.error("usage: node check-result.mjs <result.json>");
    return 2;
  }
  let result: unknown;
  try {
    result = parseJson(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (e: unknown) {
    const code = errCode(e);
    const why =
      code === "ENOENT"
        ? "no such file"
        : e instanceof SyntaxError
          ? `not valid JSON (${e.message})`
          : `cannot read (${code ?? errMsg(e)})`;
    for (const line of report([`${file}: ${why}`])) console.error(line);
    return 1;
  }
  const errors = resultErrors(result);
  for (const line of report(errors)) console.error(line);
  return errors.length ? 1 : 0;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
