// Run contract v3: which run a hook call belongs to, from the hook process's environment. A registered run
// (AGENT_RUN_MANIFEST and AGENT_RUN_ID, loaded and pinned by hooks/registration.mjs), a run whose registration fails
// (rule run-registration), or no run. Nothing here throws.

import type { Mode, Registration } from "../core/registration.mjs";
import { RULE } from "../core/registration.mjs";
import type { RunFacts } from "../core/types.mjs";
import type { Trust } from "./checker.mjs";
import type { LoadOptions } from "./registration.mjs";
import { loadRegistration } from "./registration.mjs";

type Env = Readonly<Record<string, string | undefined>>;

export interface RegisteredRun {
  // result.checker's real path, vetted
  checker?: string;
  // AGENT_RUN_PROTECTED_PATHS, one glob a line
  extra: string[];
  mode: Mode;
  // the manifest's real path
  path: string;
  registration: Registration;
  // AGENT_RUN_FILE as given (trimmed), resolved against the session's cwd by the gate
  runFile?: string;
  runId: string;
  sha256: string;
  state: "registered";
  // how the manifest is trusted: owner (out of the user's reach) or digest (AGENT_RUN_MANIFEST_SHA256)
  trust: Trust;
  // AGENT_RUN_TICKET, `<owner>/<repo>#<number>`, and its number
  ticket?: string;
  ticketNumber?: string;
}

export interface RunDeny {
  // the session pin alone failed the registration
  pin?: true;
  rule: typeof RULE;
  state: "deny";
  why: string;
}

export type RunContext = { state: "none" } | RunDeny | RegisteredRun;

// Run contract 2 named the run variables GUARD_RUN_*. Guard reads them for no decision, only to fail closed: a runner
// still on contract 2 after a plugin update must not get an ordinary unregistered session with no run rules. Each
// old name set (not blank) without its AGENT_RUN_* twin set to the same value is returned. The five identity names
// count on their own; the protected-paths and events-file names count once the run is identified (by an identity
// name or an AGENT_RUN_* one), so a runner moving names cannot lose its extra globs or its events file in silence,
// while either of the two alone stays an ordinary session.
const OLD_RUN_VARS = ["ID", "TICKET", "MODE", "FILE", "MANIFEST"] as const;
const OLD_RUN_EXTRAS = ["PROTECTED_PATHS", "EVENTS_FILE"] as const;

const staleOf = (env: Env, names: readonly string[]): string[] =>
  names
    .filter((k) => {
      const old = env[`GUARD_RUN_${k}`];
      return (
        old !== undefined && old.trim() !== "" && env[`AGENT_RUN_${k}`] !== old
      );
    })
    .map((k) => `GUARD_RUN_${k}`);

// The AGENT_RUN_* identity: a run id, a manifest variable (defined, even blank, as the loader reads it) or a digest.
const agentRunNamed = (env: Env): boolean =>
  (env.AGENT_RUN_ID ?? "").trim() !== "" ||
  env.AGENT_RUN_MANIFEST !== undefined ||
  env.AGENT_RUN_MANIFEST_SHA256 !== undefined;

export function staleRunVars(env: Env): string[] {
  const core = staleOf(env, OLD_RUN_VARS);
  const identified =
    agentRunNamed(env) ||
    OLD_RUN_VARS.some((k) => (env[`GUARD_RUN_${k}`] ?? "").trim() !== "");
  return identified ? [...core, ...staleOf(env, OLD_RUN_EXTRAS)] : core;
}

// Whether the environment names a run at all (registered, failing or on the old names): a guard crash then fails
// closed.
export const runIdentified = (env: Env): boolean =>
  agentRunNamed(env) || staleRunVars(env).length > 0;

// The run this hook call belongs to. `opts` as for loadRegistration (dataDir and sessionId pin the manifest).
export function runContext(env: Env, opts: LoadOptions = {}): RunContext {
  try {
    const stale = staleRunVars(env);
    if (stale.length > 0) {
      return {
        state: "deny",
        rule: RULE,
        why: `run contract 2 variables are set (${stale.join(", ")}) without the same value in AGENT_RUN_*: this guard speaks run contract 3 only, so the runner must set AGENT_RUN_* and register a contract 3 manifest`,
      };
    }
    const loaded = loadRegistration(env, opts);
    if (loaded.state === "deny") {
      return {
        state: "deny",
        rule: RULE,
        why: loaded.why,
        ...(loaded.pin ? { pin: true as const } : {}),
      };
    }
    if (loaded.state === "none") {
      return { state: "none" };
    }
    // loadRegistration checked AGENT_RUN_ID, AGENT_RUN_MODE and AGENT_RUN_TICKET as given.
    const ticket = env.AGENT_RUN_TICKET;
    const runFile = (env.AGENT_RUN_FILE ?? "").trim();
    return {
      state: "registered",
      registration: loaded.registration,
      path: loaded.path,
      sha256: loaded.sha256,
      trust: loaded.trust,
      ...(loaded.checker === undefined ? {} : { checker: loaded.checker }),
      runId: env.AGENT_RUN_ID ?? "",
      mode: env.AGENT_RUN_MODE === "attended" ? "attended" : "unattended",
      ...(ticket
        ? { ticket, ticketNumber: ticket.slice(ticket.lastIndexOf("#") + 1) }
        : {}),
      ...(runFile ? { runFile } : {}),
      extra: (env.AGENT_RUN_PROTECTED_PATHS ?? "")
        .split(/\r?\n/)
        .map((g) => g.trim())
        .filter(Boolean),
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      state: "deny",
      rule: RULE,
      why: `cannot be checked (${msg.slice(0, 100)})`,
    };
  }
}

// The shell and edit rules' facts for a registered run, or null for an attended one (result gate only).
// `at` is where the session is: the repo root and the cwd (`/` separators).
export function runFacts(
  run: RegisteredRun,
  at: { cwd?: string; root?: string },
): RunFacts | null {
  if (run.mode === "attended") return null;
  const reg = run.registration;
  const labels = reg.labels ?? {};
  const named =
    labels.approval !== undefined ||
    labels.takeover !== undefined ||
    (labels.protected?.length ?? 0) > 0;
  return {
    ...(named ? { labels } : {}),
    ...(reg.requires.includes("labels") && !named ? { unsure: true } : {}),
    protect: {
      ...at,
      registered: reg.protected_paths?.globs ?? [],
      exempt: reg.protected_paths?.exempt ?? [],
      extra: run.extra,
    },
  };
}

// The deny reason for a tool call, or the block reason for a stop, in a run whose registration failed.
export function denyReason(deny: RunDeny, at: "stop" | "tool"): string {
  return at === "tool"
    ? `Run registration failed: ${deny.why}. Guard denies every tool call guard sees in this run until the runner fixes its registration; stop and report it.`
    : `Run registration failed: ${deny.why}. Every tool call guard sees in this run is denied until the runner fixes its registration; stop and report it.`;
}
