// Which changes the stop check may skip: a change set made only of plain docs (README, docs/, *.md, images, ...).
// Pure: the stop hook lists the changed paths and reads the repo's `.stop-check-ignore`; this decides.
//
// Rules are gitignore-style patterns, evaluated in order, the last match winning: a plain pattern marks a path
// skippable, a `!pattern` marks it as needing the check. A path no rule matches needs the check. A pattern without
// a `/` matches the file name at any depth (`*.md`); one with a `/` is anchored at the repo root (`docs/**`); `**`
// spans directories, `*` and `?` do not. Matching ignores case (macOS and Windows file systems do too).
import { DEFAULT_RULES } from "./constants.mjs";
export { DEFAULT_RULES };
const escape = (s) => s.replace(/[.+^$${}()|[\]\\]/g, "\\$&");
function toRegex(pattern) {
    const anchored = pattern.replace(/\/$/, "").includes("/");
    const body = pattern.replace(/^\//, "").replace(/\/$/, "/**");
    let re = "";
    for (let i = 0; i < body.length; i++) {
        const c = body[i] ?? "";
        if (c === "*" && body[i + 1] === "*") {
            if (body[i + 2] === "/") {
                re += "(?:.*/)?";
                i += 2;
            }
            else {
                re += ".*";
                i += 1;
            }
        }
        else if (c === "*")
            re += "[^/]*";
        else if (c === "?")
            re += "[^/]";
        else
            re += escape(c);
    }
    return new RegExp(`${anchored ? "^" : "(?:^|/)"}${re}$`, "i");
}
/** Parse gitignore-style rule lines into compiled regex rules. */
export function parseRules(text) {
    return (text ?? "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"))
        .map((l) => l.startsWith("!")
        ? { skip: false, re: toRegex(l.slice(1)) }
        : { skip: true, re: toRegex(l) });
}
const DEFAULTS = parseRules(DEFAULT_RULES);
/** Return whether one repo-relative path may skip the check under `rules`. */
export function skippable(path, rules = DEFAULTS) {
    const p = path.replace(/\\/g, "/").replace(/^\.\//, "");
    let skip = false;
    for (const r of rules)
        if (r.re.test(p))
            skip = r.skip;
    return skip;
}
/** Return true only when every path is skippable; an empty or missing list is never docs-only. */
export function docsOnly(paths, repoRules = "") {
    if (!Array.isArray(paths) || !paths.length)
        return false;
    const rules = repoRules ? [...DEFAULTS, ...parseRules(repoRules)] : DEFAULTS;
    const checkedPaths = paths;
    return checkedPaths.every((p) => skippable(p, rules));
}
