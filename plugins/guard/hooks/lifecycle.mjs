// Branch lifecycle helpers (github-workflow, Branch lifecycle): the daily repo sweep started at session start, the
// warn-only stop reminder about unpushed work, and the notes handed to the agent on its next turn.
// Every function here fails open: an error, a missing tool or a timeout yields nothing and never throws.
// Starts dev-tools' repo-sweep.mjs --auto detached when the repo's daily stamp is stale; a no-op otherwise.
export function startSessionSweep(_opts) {
    // groundwork stub: implemented in the guard hooks unit
}
// The previous auto sweep's one-line summary, or a nudge when the sweep could not run and the repo is cluttered;
// null when there is nothing new to say for this repo.
export function sweepNotice(_cwd, _env) {
    return null;
}
// The warn-only reminder for the cwd's current branch: unpushed commits, or pushed with no open PR.
export function lifecycleReminder(_cwd, _env, _opts = {}) {
    return null;
}
// Queue a note for the agent's next turn (stop hooks cannot add context without holding the stop).
export function queueAgentNote(_dataDir, _session, _text) {
    // groundwork stub
}
// Take (and clear) the notes queued for this session.
export function takeAgentNotes(_dataDir, _session) {
    return [];
}
