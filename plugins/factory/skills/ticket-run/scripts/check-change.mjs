// Checks a change run's unit brief (.factory/runs/<change>/unit-<attempt>.json), the format in references/change.md.
// Usage `node check-change.mjs <unit.json>`: exit 0 valid, 1 invalid or unreadable (one line per error), 2 usage.
// The CLI also checks `max_attempts` and the roles (approver item authors, `head_pusher`) against the config committed
// on the default branch (committedConfig in gate.mjs).
// Imports Node built-ins, ./check-result.mjs and ./gate.mjs (its committedConfig) only.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CHANGE_TRIGGERS, TICKET, report, show } from "./check-result.mjs";
import { committedConfig, parseConfig } from "./gate.mjs";
export const UNIT_KEYS = [
    "unit",
    "version",
    "run_id",
    "change",
    "pr",
    "issues",
    "branch",
    "head",
    "head_pusher",
    "trigger",
    "attempt",
    "max_attempts",
    "items",
];
export const ITEM_KEYS = [
    "source",
    "kind",
    "author",
    "role",
    "path",
    "line",
    "text",
];
export const ITEM_KINDS = ["review", "review_comment", "comment", "check"];
export const ROLES = ["approver", "reviewer", "check"];
export const MAX_ITEMS = 50;
export const MAX_TEXT = 4000;
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isString = (v) => typeof v === "string" && v !== "";
const parseJson = (text) => JSON.parse(text);
const errCode = (e) => isObject(e) && typeof e.code === "string" ? e.code : undefined;
const errMsg = (e) => e instanceof Error
    ? e.message
    : isObject(e) && typeof e.message === "string"
        ? e.message
        : typeof e;
const errStderr = (e) => {
    if (!isObject(e))
        return "";
    if (typeof e.stderr === "string")
        return e.stderr;
    if (Buffer.isBuffer(e.stderr))
        return e.stderr.toString("utf8");
    return "";
};
const keyErrors = (value, keys, at) => [
    ...keys.filter((k) => !(k in value)).map((k) => `${at}${k}: missing`),
    ...Object.keys(value)
        .filter((k) => !keys.includes(k))
        .map((k) => `${at}${show(k)}: unknown key`),
];
const itemErrors = (item, i, seen) => {
    const at = `items[${String(i)}]`;
    if (!isObject(item))
        return [`${at}: must be an object, got ${show(item)}`];
    const errors = keyErrors(item, ITEM_KEYS, `${at}.`);
    if (typeof item.source !== "string" || !item.source.startsWith("https://")) {
        errors.push(`${at}.source: must be an https:// URL, got ${show(item.source)}`);
    }
    else if (seen.has(item.source)) {
        errors.push(`${at}.source: ${show(item.source)} appears twice`);
    }
    else {
        seen.add(item.source);
    }
    if (typeof item.kind !== "string" || !ITEM_KINDS.includes(item.kind)) {
        errors.push(`${at}.kind: must be one of ${ITEM_KINDS.join(", ")}, got ${show(item.kind)}`);
    }
    if (typeof item.role !== "string" || !ROLES.includes(item.role)) {
        errors.push(`${at}.role: must be one of ${ROLES.join(", ")}, got ${show(item.role)}`);
    }
    if ((item.kind === "check") !== (item.role === "check")) {
        errors.push(`${at}.role: check exactly for a check item, got kind ${show(item.kind)} and role ${show(item.role)}`);
    }
    if (item.kind === "check" ? item.author !== null : !isString(item.author)) {
        errors.push(`${at}.author: must be null for a check and a non-empty string otherwise, got ${show(item.author)}`);
    }
    if (item.path !== null && typeof item.path !== "string") {
        errors.push(`${at}.path: must be a string or null, got ${show(item.path)}`);
    }
    if (item.line !== null &&
        !(typeof item.line === "number" &&
            Number.isInteger(item.line) &&
            item.line > 0)) {
        errors.push(`${at}.line: must be a positive integer or null, got ${show(item.line)}`);
    }
    else if (item.line !== null && item.path === null) {
        errors.push(`${at}.line: needs a path`);
    }
    if (item.kind !== "review_comment" &&
        (item.path !== null || item.line !== null)) {
        errors.push(`${at}: path and line must be null unless kind is review_comment, got kind ${show(item.kind)}`);
    }
    if (typeof item.text !== "string") {
        errors.push(`${at}.text: must be a string, got ${show(item.text)}`);
    }
    else if (item.text.length > MAX_TEXT) {
        errors.push(`${at}.text: ${String(item.text.length)} characters, at most ${String(MAX_TEXT)}`);
    }
    return errors;
};
/** Validates a change run's unit brief object against the `change_fix` schema. */
export const unitErrors = (unit) => {
    if (!isObject(unit))
        return [`unit must be a JSON object, got ${show(unit)}`];
    const errors = keyErrors(unit, UNIT_KEYS, "");
    if (unit.unit !== "change_fix")
        errors.push(`unit: must be "change_fix", got ${show(unit.unit)}`);
    if (unit.version !== 2)
        errors.push(`version: must be 2, got ${show(unit.version)}`);
    if (!isString(unit.run_id))
        errors.push(`run_id: must be a non-empty string, got ${show(unit.run_id)}`);
    const change = typeof unit.change === "string" && TICKET.test(unit.change)
        ? unit.change
        : null;
    if (!change)
        errors.push(`change: must be <owner>/<repo>#<number>, got ${show(unit.change)}`);
    const m = change ? /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(change) : null;
    const p = typeof unit.pr === "string"
        ? /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)$/.exec(unit.pr)
        : null;
    if (!p) {
        errors.push(`pr: must be https://github.com/<owner>/<repo>/pull/<number>, got ${show(unit.pr)}`);
    }
    else if (m?.[1] !== undefined &&
        m[2] !== undefined &&
        m[3] !== undefined &&
        p[1] !== undefined &&
        p[2] !== undefined &&
        p[3] !== undefined &&
        (p[1].toLowerCase() !== m[1].toLowerCase() ||
            p[2].toLowerCase() !== m[2].toLowerCase() ||
            p[3] !== m[3])) {
        errors.push(`pr: ${show(unit.pr)} is not the change ${show(change)}`);
    }
    const { issues } = unit;
    if (!Array.isArray(issues) ||
        issues.length === 0 ||
        !issues.every((i) => typeof i === "string" && TICKET.test(i)) ||
        new Set(issues.map((i) => i.toLowerCase())).size !== issues.length) {
        errors.push(`issues: must be a non-empty array of unique <owner>/<repo>#<number>, got ${show(issues)}`);
    }
    else if (typeof change === "string" &&
        issues.some((i) => i.toLowerCase() === change.toLowerCase())) {
        errors.push(`issues: must not include the change ${show(unit.change)}`);
    }
    if (typeof unit.branch !== "string" ||
        !/^(?!-)[\w./-]+$/.test(unit.branch) ||
        unit.branch.includes("..")) {
        errors.push(`branch: must be one plain ref name, got ${show(unit.branch)}`);
    }
    if (typeof unit.head !== "string" || !/^[0-9a-f]{40}$/.test(unit.head)) {
        errors.push(`head: must be 40 lowercase hex, got ${show(unit.head)}`);
    }
    if (typeof unit.trigger !== "string" ||
        !CHANGE_TRIGGERS.includes(unit.trigger)) {
        errors.push(`trigger: must be one of ${CHANGE_TRIGGERS.join(", ")}, got ${show(unit.trigger)}`);
    }
    const max = unit.max_attempts;
    const maxValid = typeof max === "number" && Number.isInteger(max) && max >= 1;
    if (!maxValid) {
        errors.push(`max_attempts: must be an integer of at least 1, got ${show(max)}`);
    }
    if (typeof unit.attempt !== "number" ||
        !Number.isInteger(unit.attempt) ||
        unit.attempt < 1 ||
        (typeof max === "number" && Number.isInteger(max) && unit.attempt > max)) {
        errors.push(`attempt: must be an integer from 1 to max_attempts, got ${show(unit.attempt)} of ${show(max)}`);
    }
    if (!Array.isArray(unit.items) ||
        unit.items.length < 1 ||
        unit.items.length > MAX_ITEMS) {
        errors.push(`items: must be an array of 1 to ${String(MAX_ITEMS)}, got ${Array.isArray(unit.items) ? String(unit.items.length) : show(unit.items)}`);
    }
    if (Array.isArray(unit.items)) {
        const seen = new Set();
        unit.items.forEach((item, i) => errors.push(...itemErrors(item, i, seen)));
        const items = unit.items.filter(isObject);
        if (unit.trigger === "check_failed"
            ? !items.some((i) => i.kind === "check")
            : typeof unit.trigger === "string" &&
                CHANGE_TRIGGERS.includes(unit.trigger) &&
                !items.some((i) => i.role === "approver")) {
            errors.push(unit.trigger === "check_failed"
                ? "items: a check_failed unit needs at least one check item"
                : `items: a ${String(unit.trigger)} unit needs at least one approver item`);
        }
    }
    // A failed check is acted on only on a head a factory or approver login pushed, or that an approver's answer on the
    // change allowed (that answer is then an approver comment item).
    const pusher = unit.head_pusher;
    if (unit.trigger !== "check_failed") {
        if ("head_pusher" in unit && pusher !== null) {
            errors.push(`head_pusher: must be null unless trigger is check_failed, got ${show(pusher)}`);
        }
    }
    else if (pusher === null) {
        if (!(Array.isArray(unit.items) &&
            unit.items.some((i) => isObject(i) && i.role === "approver" && i.kind === "comment"))) {
            errors.push("head_pusher: a check_failed unit needs the factory or approver login that pushed head, or an approver's answer as a comment item");
        }
    }
    else if (pusher !== undefined &&
        !(isString(pusher) && pusher.trim() === pusher)) {
        errors.push(`head_pusher: must be a login or null, got ${show(pusher)}`);
    }
    return errors;
};
// `change_requests.max_attempts` from a config text, in the plain YAML the template uses; absent, the default.
export const DEFAULT_MAX_ATTEMPTS = 3;
/** Parses `change_requests.max_attempts` from `.factory/config.yaml` text, defaulting to `DEFAULT_MAX_ATTEMPTS`. */
export const parseCap = (text) => {
    const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
    const at = lines.findIndex((l) => l.startsWith("change_requests:"));
    if (at === -1)
        return DEFAULT_MAX_ATTEMPTS;
    const header = lines[at] ?? "";
    if (!/^change_requests:\s*(?:#.*)?$/.test(header)) {
        throw new Error("change_requests must be a block mapping");
    }
    for (const line of lines.slice(at + 1)) {
        if (/^\S/.test(line) && !line.startsWith("#"))
            break;
        const m = /^\s+max_attempts:\s*(.*?)\s*(?:#.*)?$/.exec(line);
        if (!m?.[1])
            continue;
        if (!/^[1-9]\d{0,3}$/.test(m[1])) {
            throw new Error(`change_requests.max_attempts must be a whole number from 1, got ${show(m[1])}`);
        }
        return Number(m[1]);
    }
    return DEFAULT_MAX_ATTEMPTS;
};
/**
 * The cap as committed on the default branch (gate.mjs's committedConfig), never the checkout's copy: a change run
 * works the change's branch, where a session could raise it. No config key there: the default; any read that fails
 * throws. The CLI needs the config file itself, for the roles.
 */
export const committedCap = (run) => parseCap(committedConfig(run) ?? "");
/**
 * Roles from the default branch's committed config, never the checkout's (a change's branch can list anyone): every
 * approver item's author is an approver, `head_pusher` is an approver or an identity login, and no item is the factory's.
 */
export const roleErrors = (unit, config) => {
    if (!isObject(unit))
        return [];
    const lc = (s) => s.toLowerCase();
    const inList = (list, u) => typeof u === "string" && list.map(lc).includes(lc(u));
    const apr = (u) => inList(config.approvers, u) &&
        (config.approversAllowBots || !lc(u).endsWith("[bot]"));
    const factory = (u) => inList(config.identityLogins, u);
    const errors = [];
    if (Array.isArray(unit.items)) {
        unit.items.forEach((item, i) => {
            if (!isObject(item) || typeof item.author !== "string")
                return;
            if (factory(item.author)) {
                errors.push(`items[${String(i)}].author: ${show(item.author)} is a factory login (identity.logins on the default branch); no item is the factory's own`);
            }
            else if (item.role === "approver" && !apr(item.author)) {
                errors.push(`items[${String(i)}].author: ${show(item.author)} is not an approver in the default branch's config`);
            }
        });
    }
    if (typeof unit.head_pusher === "string" &&
        !apr(unit.head_pusher) &&
        !factory(unit.head_pusher)) {
        errors.push(`head_pusher: ${show(unit.head_pusher)} is neither an approver nor in identity.logins in the default branch's config`);
    }
    return errors;
};
/** Checks that `unit.max_attempts` matches the cap committed on the default branch. */
export const capErrors = (unit, cap) => isObject(unit) &&
    typeof unit.max_attempts === "number" &&
    Number.isInteger(unit.max_attempts) &&
    unit.max_attempts !== cap
    ? [
        `max_attempts: ${String(unit.max_attempts)} is not the cap committed on the default branch, ${String(cap)}`,
    ]
    : [];
// Exit code, not process.exit: an exit mid-pipe can cut stderr short.
const main = (args) => {
    const [file] = args;
    if (!file || args.length > 1) {
        console.error("usage: node check-change.mjs <unit.json>");
        return 2;
    }
    let unit;
    try {
        unit = parseJson(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    }
    catch (e) {
        const code = errCode(e);
        const why = code === "ENOENT"
            ? "no such file"
            : e instanceof SyntaxError
                ? `not valid JSON (${e.message})`
                : `cannot read (${code ?? errMsg(e)})`;
        for (const line of report([`${file}: ${why}`]))
            console.error(line);
        return 1;
    }
    const errors = unitErrors(unit);
    // The cap and the roles come from the config committed on the default branch; any read that fails fails the check.
    try {
        const text = committedConfig();
        if (text === null)
            throw new Error("no .factory/config.yaml there");
        errors.push(...capErrors(unit, parseCap(text)), ...roleErrors(unit, parseConfig(text)));
    }
    catch (e) {
        const errLine = errStderr(e).trim().split("\n")[0];
        const why = errLine && errLine.length > 0 ? errLine : errMsg(e);
        errors.push(`config: cannot read .factory/config.yaml committed on the default branch (${why}): fetch the default branch (git fetch origin)`);
    }
    for (const line of report(errors))
        console.error(line);
    return errors.length ? 1 : 0;
};
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    process.exitCode = main(process.argv.slice(2));
}
