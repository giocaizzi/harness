// Branch lifecycle helpers (github-workflow, Branch lifecycle): the daily repo sweep started at session start, the
// warn-only stop reminder about unpushed work, and the notes handed to the agent on its next turn.
// Every function here fails open: an error, a missing tool or a timeout yields nothing and never throws.

import type { EnvMap } from "../core/types.mjs";

export interface SweepStartOptions {
  cwd: string;
  env: EnvMap;
  // This plugin's root (guard); dev-tools' repo-sweep.mjs is resolved beside it.
  pluginRoot: string;
  // A registered run (run contract v2) never starts a sweep.
  registered: boolean;
}

// Starts dev-tools' repo-sweep.mjs --auto detached when the repo's daily stamp is stale; a no-op otherwise.
export function startSessionSweep(_opts: SweepStartOptions): void {
  // groundwork stub: implemented in the guard hooks unit
}

// The previous auto sweep's one-line summary, or a nudge when the sweep could not run and the repo is cluttered;
// null when there is nothing new to say for this repo.
export function sweepNotice(_cwd: string, _env: EnvMap): string | null {
  return null;
}

export interface LifecycleReminder {
  // Shown to the user (stop systemMessage) and queued as agent context for the next turn.
  message: string;
  // Dedup key: once per session per branch and head.
  key: string;
}

export interface ReminderOptions {
  // The subagent's type at SubagentStop; only driver and escalate are reminded.
  agentType?: string;
}

// The warn-only reminder for the cwd's current branch: unpushed commits, or pushed with no open PR.
export function lifecycleReminder(
  _cwd: string,
  _env: EnvMap,
  _opts: ReminderOptions = {},
): LifecycleReminder | null {
  return null;
}

// Queue a note for the agent's next turn (stop hooks cannot add context without holding the stop).
export function queueAgentNote(
  _dataDir: string,
  _session: string,
  _text: string,
): void {
  // groundwork stub
}

// Take (and clear) the notes queued for this session.
export function takeAgentNotes(_dataDir: string, _session: string): string[] {
  return [];
}
