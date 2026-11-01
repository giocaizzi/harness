// Writes a run's .factory/runs/<n>/result.json from the judgment fields the run decided, filling the fields it can know
// (schema, ticket, run_id, finished_at, mode, host name and os) and checking the whole file before writing it.
// Usage:
//   node write-result.mjs [--ticket <owner>/<repo>#<n>] [--run-id <id>] <input.json|->   write the result
//   node write-result.mjs [--ticket <owner>/<repo>#<n>] --post <kind>=<url>             add a posted comment, keep finished_at
// Exit 0 written (its path on stdout), 1 invalid (errors on stderr, nothing written), 2 usage or environment.
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TICKET, report, resultErrors, show } from "./check-result.mjs";
import type {
  BuildResultOptions,
  BuildResultOutput,
  EnvMap,
  PathLike,
  ResolveRunIdOptions,
} from "./types.mjs";

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

// The keys the run decides, in the contract's order; `host` may carry only `runner`.
export const JUDGMENT = [
  "end_state",
  "reason",
  "reason_code",
  "pr",
  "tasks",
  "change",
  "decisions",
  "evidence",
  "checks",
  "follow_ups",
  "posts",
  "phases",
  "verifier",
  "routing",
  "cost_usd",
  "tokens",
  "turns",
  "harness",
  "model",
  "effort",
  "sessions",
  "plugin_versions",
  "host",
];
export const OWNED = ["schema", "ticket", "run_id", "mode", "finished_at"];
const ORDER = [
  "schema",
  "ticket",
  "run_id",
  ...JUDGMENT.slice(0, 14),
  "mode",
  ...JUDGMENT.slice(14),
  "finished_at",
];
const RUNNERS = ["attended", "headless", "runtime"];
// A session or claim id: no control or format characters (newlines included), no surrounding spaces, at most 128.
const RUN_ID = /^(?=.{1,128}$)[^\p{C}\s](?:[^\p{C}]*[^\p{C}\s])?$/u;

export class UsageError extends Error {}

const cut = (key: string): string =>
  key.length > 200 ? `${key.slice(0, 200)}…` : key;

const utcNow = (now: Date): string =>
  now.toISOString().replace(/\.\d{3}Z$/, "Z");

/** Maps Node's `process.platform` to the contract's `host.os` string. */
export const hostOs = (platform: string): string =>
  platform === "win32" ? "windows" : platform;

/** Resolves the ticket identifier from `FACTORY_TICKET`, `--ticket`, or `FACTORY_ATTENDED_TICKET`. */
export const resolveTicket = (env: EnvMap, ticketArg?: string): string => {
  const runtime = (env.FACTORY_TICKET ?? "").trim();
  const ticket =
    runtime || (ticketArg ?? "") || (env.FACTORY_ATTENDED_TICKET ?? "").trim();
  if (runtime && ticketArg && ticketArg !== runtime) {
    throw new UsageError(
      `--ticket ${show(ticketArg)} differs from FACTORY_TICKET ${show(runtime)}`,
    );
  }
  if (!ticket) {
    throw new UsageError(
      "no ticket: FACTORY_TICKET and FACTORY_ATTENDED_TICKET are unset, so pass --ticket <owner>/<repo>#<n>",
    );
  }
  if (!TICKET.test(ticket)) {
    throw new UsageError(
      `ticket must be <owner>/<repo>#<number>, got ${show(ticket)}`,
    );
  }
  return ticket;
};

/** Resolves `run_id` from runtime env, attended launcher env, `--run-id`, or a generated fallback. */
export const resolveRunId = ({
  env,
  ticket,
  runIdArg,
  host,
  now,
  warn,
}: ResolveRunIdOptions): string => {
  const runtime = (env.FACTORY_RUN_ID ?? "").trim();
  const attendedTicket = (env.FACTORY_ATTENDED_TICKET ?? "").trim();
  const attendedId = (env.FACTORY_ATTENDED_RUN_ID ?? "").trim();
  let id = runtime;
  if (!id && attendedTicket) {
    if (attendedTicket.toLowerCase() === ticket.toLowerCase()) id = attendedId;
    else {
      warn(
        `FACTORY_ATTENDED_TICKET is ${show(attendedTicket)}, not ${ticket}: this session's telemetry is tagged for that ticket, so its run id is not used; tell the person`,
      );
    }
  }
  if (id && runIdArg && runIdArg !== id) {
    warn(
      `--run-id ${runIdArg} ignored: ${runtime ? "FACTORY_RUN_ID" : "FACTORY_ATTENDED_RUN_ID"} gives ${id}`,
    );
  }
  const shortHost = host.split(".")[0] ?? host;
  const issueNum = ticket.split("#")[1] ?? "";
  return id !== ""
    ? id
    : runIdArg !== "" && runIdArg !== undefined
      ? runIdArg
      : `${shortHost}-${issueNum}-${utcNow(now).replace(/[-:]/g, "")}`;
};

/** Validates that the caller's judgment input contains only allowed keys and values. */
export const inputErrors = (input: unknown, env: EnvMap = {}): string[] => {
  if (!isRecord(input))
    return ["the input must be a JSON object of the judgment fields"];
  const errors: string[] = [];
  for (const key of Object.keys(input)) {
    if (OWNED.includes(key))
      errors.push(`${key}: filled by this script, remove it from the input`);
    else if (!JUDGMENT.includes(key)) {
      errors.push(
        `${cut(key)}: not a result key the run writes (allowed: ${JUDGMENT.join(", ")})`,
      );
    }
  }
  if (input.host !== undefined) {
    if (!isRecord(input.host)) {
      errors.push("host must be an object holding only runner");
    } else {
      for (const key of Object.keys(input.host)) {
        if (key !== "runner") {
          errors.push(
            `host.${cut(key)}: filled by this script, remove it from the input`,
          );
        }
      }
      const runtime = (env.FACTORY_RUN_ID ?? "").trim() !== "";
      const runner = input.host.runner;
      if (
        "runner" in input.host &&
        (typeof runner !== "string" || !RUNNERS.includes(runner))
      ) {
        errors.push(`host.runner must be one of ${RUNNERS.join(", ")}`);
      } else if (runner === "runtime" && !runtime) {
        errors.push(
          "host.runner runtime needs FACTORY_RUN_ID: a run without it is attended or headless",
        );
      } else if (
        typeof runner === "string" &&
        runner !== "runtime" &&
        runtime
      ) {
        errors.push(
          `host.runner ${runner} contradicts FACTORY_RUN_ID: a runtime's run is runtime`,
        );
      }
    }
  }
  if (input.end_state === "halted")
    errors.push("end_state halted is written only by a runtime");
  if (input.reason_code === "takeover") {
    errors.push("reason_code takeover is written only by a runtime");
  }
  if (
    Array.isArray(input.tasks) &&
    input.tasks.some(
      (t: unknown) => isRecord(t) && t.reason_code === "takeover",
    )
  ) {
    errors.push("tasks: reason_code takeover is written only by a runtime");
  }
  return errors;
};

/** Builds and validates the full `result.json` object from the caller's judgment input. */
export const buildResult = (
  input: unknown,
  {
    env,
    ticket,
    runIdArg,
    now = new Date(),
    host = hostname(),
    platform = process.platform,
    warn = () => undefined,
  }: BuildResultOptions,
): BuildResultOutput => {
  const errors = inputErrors(input, env);
  if (errors.length || !isRecord(input)) return { errors };
  const finished_at = utcNow(now);
  const hostRunner =
    isRecord(input.host) && typeof input.host.runner === "string"
      ? input.host.runner
      : undefined;
  const filled: Record<string, unknown> = {
    ...input,
    schema: input.tasks === undefined ? 2 : 3,
    ticket,
    run_id: resolveRunId({ env, ticket, runIdArg, host, now, warn }),
    ...(env.FACTORY_DEV === "1" ? { mode: "dev" } : {}),
    host: {
      name: host,
      os: hostOs(platform),
      runner:
        hostRunner ??
        ((env.FACTORY_RUN_ID ?? "").trim() ? "runtime" : "attended"),
    },
    finished_at,
  };
  // The record step ends when the file is written.
  const rawPhases = filled.phases;
  if (Array.isArray(rawPhases)) {
    const phases: unknown[] = rawPhases;
    const last: unknown = phases.at(-1);
    if (isRecord(last) && last.name === "record" && last.ended_at === null) {
      filled.phases = [
        ...phases.slice(0, -1),
        { ...last, ended_at: finished_at },
      ];
    }
  }
  const result = Object.fromEntries(
    ORDER.filter((k) => k in filled).map((k) => [k, filled[k]]),
  );
  return { result, errors: resultErrors(result, env) };
};

/** Appends or marks a posted comment on an existing `result.json` object without changing `finished_at`. */
export const addPost = (
  result: unknown,
  ticket: string,
  post: string,
  env: EnvMap,
): BuildResultOutput => {
  const m = /^([a-z][a-z_]*)=(https?:\/\/\S+)$/.exec(post);
  if (!m?.[1] || !m[2])
    throw new UsageError(`--post takes <kind>=<url>, got ${show(post)}`);
  if (!isRecord(result)) return { errors: resultErrors(result, env) };
  if (result.ticket !== ticket) {
    return {
      errors: [`the result's ticket ${show(result.ticket)} is not ${ticket}`],
    };
  }
  const kind = m[1];
  const url = m[2];
  const posts: unknown[] = Array.isArray(result.posts) ? result.posts : [];
  // A URL already listed (as posting or maybe_posted) is now known to be posted; posting it again changes nothing.
  const listed = posts.some((p: unknown) => isRecord(p) && p.url === url);
  const next: Record<string, unknown> = {
    ...result,
    posts: listed
      ? posts.map((p: unknown) =>
          isRecord(p) && p.url === url ? { ...p, state: "posted" } : p,
        )
      : [...posts, { kind, url, state: "posted" }],
  };
  return { result: next, errors: resultErrors(next, env) };
};

/** Computes `<main checkout>/.factory/runs/<n>/result.json` from git's common directory. */
export const resultPath = (
  commonDir: string,
  ticket: string,
  p: PathLike = path,
): string =>
  p.join(
    p.dirname(commonDir),
    ".factory",
    "runs",
    ticket.split("#")[1] ?? "",
    "result.json",
  );

interface ParsedArgs {
  ticket?: string | undefined;
  runId?: string | undefined;
  post?: string | undefined;
  input?: string | undefined;
}

const parseArgs = (argv: readonly string[]): ParsedArgs => {
  const args: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--ticket" || a === "--run-id" || a === "--post") {
      const key =
        a === "--ticket" ? "ticket" : a === "--run-id" ? "runId" : "post";
      const val = argv[i + 1];
      if (val === undefined || args[key] !== undefined) {
        throw new UsageError(`${a} needs one value`);
      }
      args[key] = val;
      i++;
    } else if (a.startsWith("--") || args.input !== undefined) {
      throw new UsageError(`unexpected argument ${a}`);
    } else {
      args.input = a;
    }
  }
  if ((args.input === undefined) === (args.post === undefined)) {
    throw new UsageError(
      "give an input file (or - for stdin) or --post <kind>=<url>, not both",
    );
  }
  if (args.post !== undefined && args.runId !== undefined) {
    throw new UsageError("--run-id applies to a write, not to --post");
  }
  if (args.runId !== undefined && !RUN_ID.test(args.runId)) {
    throw new UsageError(
      `--run-id must be 1 to 128 printable characters without spaces at either end, got ${show(args.runId)}`,
    );
  }
  return args;
};

const readJson = (file: string | number): unknown =>
  parseJson(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));

const main = (argv: readonly string[], env: EnvMap): number => {
  const args = parseArgs(argv);
  const ticket = resolveTicket(env, args.ticket);
  let commonDir: string;
  try {
    commonDir = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
  } catch {
    throw new UsageError(
      "not inside a git checkout: run it from the repo or one of its worktrees",
    );
  }
  const file = resultPath(commonDir, ticket);
  let built: BuildResultOutput;
  if (args.post !== undefined) {
    let current: unknown;
    try {
      current = readJson(file);
    } catch (e: unknown) {
      const code = errCode(e);
      if (code === "ENOENT") {
        throw new UsageError(
          `${file}: no result to add the post to; write it first`,
        );
      }
      return fail([
        `${file}: ${e instanceof SyntaxError ? `not valid JSON (${e.message})` : `cannot read (${code ?? errMsg(e)})`}`,
      ]);
    }
    built = addPost(current, ticket, args.post, env);
  } else {
    const inputArg = args.input ?? "-";
    let input: unknown;
    try {
      input = readJson(inputArg === "-" ? 0 : inputArg);
    } catch (e: unknown) {
      const code = errCode(e);
      if (code === "ENOENT") throw new UsageError(`${inputArg}: no such file`);
      return fail([
        `${inputArg === "-" ? "stdin" : inputArg}: ${e instanceof SyntaxError ? `not valid JSON (${e.message})` : `cannot read (${code ?? errMsg(e)})`}`,
      ]);
    }
    built = buildResult(input, {
      env,
      ticket,
      runIdArg: args.runId,
      warn: (w) => {
        console.error(`warning: ${w}`);
      },
    });
  }
  if (built.errors.length) return fail(built.errors);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${String(process.pid)}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(built.result, null, 2)}\n`);
    renameSync(tmp, file);
  } catch (e: unknown) {
    rmSync(tmp, { force: true });
    throw new UsageError(`${file}: cannot write (${errCode(e) ?? errMsg(e)})`);
  }
  console.log(file);
  return 0;
};

const fail = (errors: readonly string[]): number => {
  for (const line of report(errors)) console.error(line);
  console.error("nothing written: fix the input and run it again");
  return 1;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2), process.env);
  } catch (e: unknown) {
    console.error(
      e instanceof UsageError ? e.message : `write-result failed: ${errMsg(e)}`,
    );
    process.exitCode = 2;
  }
}
