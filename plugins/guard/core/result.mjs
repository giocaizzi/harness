// The result gate's own check and the helpers around the checker the launcher names (FACTORY_RESULT_CHECKER).
// Pure: no fs or process I/O. The core check holds the fields the gate itself relies on; the rest of the schema is
// the delegated checker's job, and a checker can only add errors.
import path from "node:path";
// An offending value is echoed cut to 200 characters, a line to 300, and a report to 50 lines, so a huge or hostile
// result cannot flood the output.
export const show = (v) => {
    // JSON.stringify gives undefined for a function or symbol: fall back to its string form
    const json = JSON.stringify(v);
    const text = v === undefined
        ? "undefined"
        : (json ?? v.toString());
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
};
const MAX_LINE = 300;
const MAX_LINES = 50;
export const report = (errors) => {
    const lines = errors
        .slice(0, MAX_LINES)
        .map((e) => (e.length > MAX_LINE ? `${e.slice(0, MAX_LINE)}…` : e));
    return errors.length > MAX_LINES
        ? [...lines, `… and ${String(errors.length - MAX_LINES)} more`]
        : lines;
};
export const TICKET = /^[\w.-]+\/[\w.-]+#[1-9]\d*$/;
export const coreErrors = (result, env = {}) => {
    if (result === null || typeof result !== "object" || Array.isArray(result)) {
        return [`result.json must hold a JSON object, got ${show(result)}`];
    }
    const r = result;
    const errors = [];
    const wantRun = (env.FACTORY_RUN_ID ?? "").trim();
    if (typeof r.run_id !== "string" || r.run_id.trim() === "") {
        errors.push(`run_id must be a non-empty string, got ${show(r.run_id)}`);
    }
    else if (wantRun && r.run_id !== wantRun) {
        errors.push(`run_id ${show(r.run_id)} differs from FACTORY_RUN_ID ${show(wantRun)}`);
    }
    if (typeof r.ticket !== "string" || !TICKET.test(r.ticket)) {
        errors.push(`ticket must be a string of the form "<owner>/<repo>#<number>", got ${show(r.ticket)}`);
    }
    else {
        const wantTicket = (env.FACTORY_TICKET ?? "").trim();
        if (wantTicket && r.ticket !== wantTicket) {
            errors.push(`ticket ${show(r.ticket)} differs from FACTORY_TICKET ${show(wantTicket)}`);
        }
    }
    if (typeof r.end_state !== "string" || r.end_state.trim() === "") {
        errors.push(`end_state must be a non-empty string, got ${show(r.end_state)}`);
    }
    return errors;
};
// Why a checker path is not acceptable (a short reason), or null. `value` is already trimmed. `pathApi` selects the
// platform's rules (path.win32 on Windows): a Windows path must be a drive path or a UNC share, never drive-relative,
// root-relative or a device path.
export const checkerPathError = (value, pathApi = path) => {
    if (!value)
        return "empty";
    if (value.includes("\0"))
        return "contains a NUL character";
    if (/^[a-z][a-z0-9+.-]+:/i.test(value)) {
        return "a URL or module specifier, not a file path";
    }
    const absolute = pathApi === path.win32
        ? /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/?.]/.test(value)
        : pathApi.isAbsolute(value);
    if (!absolute)
        return "not an absolute path";
    if (pathApi.extname(value).toLowerCase() !== ".mjs")
        return "not a .mjs file";
    return null;
};
// What a checker returned, bounded before it crosses the thread: { errors } or { why }.
export const checkerOutput = (v) => Array.isArray(v) && v.every((e) => typeof e === "string")
    ? { errors: report(v) }
    : { why: `returned ${show(v)}, not an array of strings` };
export const couldNotRun = (checkerPath, why) => [
    `result checker ${show(checkerPath)} (FACTORY_RESULT_CHECKER) could not run: ${why}`,
];
