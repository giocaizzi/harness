#!/usr/bin/env node
// memory-lint.mjs [--repo <path>] [<memory-dir>...]   report-only lint of Claude Code auto-memory
//
// Default dirs: ~/.claude/projects/*/memory (CLAUDE_CONFIG_DIR respected). Prints one finding per
// line as "<dir>/<file>: <what>" and always exits 0 (2 on usage errors): fixing is a judgement call.
// Checks: frontmatter has name, description and a type (user|feedback|project|reference) and
// parses (an unquoted description with ": " breaks YAML); MEMORY.md exists, links only to existing
// files, lists every file, stays under 200 lines / 25000 bytes; [[links]] and relative .md links
// resolve; files over 4 KB; append-style wording ("Update:", "superseded", "no longer");
// with --repo, backticked repo paths that no longer exist. Contradictions with skills or
// instructions need reading, not a script: see the memory-hygiene reference.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { APPEND, FILE_MAX_BYTES, INDEX_MAX_BYTES, INDEX_MAX_LINES, TYPES, } from "./constants.mjs";
function frontmatter(text) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
    const raw = match?.[1];
    if (!match || raw === undefined)
        return null;
    const fm = { body: text.slice(match[0].length), raw };
    for (const line of raw.split(/\r?\n/)) {
        const kv = /^\s*([A-Za-z_]+):\s*(.*)$/.exec(line);
        const key = kv?.[1];
        const value = kv?.[2];
        if (key !== undefined && value !== undefined && fm[key] === undefined) {
            fm[key] = value;
        }
    }
    return fm;
}
/** Return memory-index, frontmatter and stale-link findings for a directory. */
export function lintDir(dir, { repo } = {}) {
    const out = [];
    if (!readdirSync(dir).length)
        return out;
    const say = (file, what) => {
        out.push(`${dir}/${file}: ${what}`);
    };
    const files = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
    const index = existsSync(join(dir, "MEMORY.md"))
        ? readFileSync(join(dir, "MEMORY.md"), "utf8")
        : null;
    if (index === null)
        say("MEMORY.md", "missing");
    else {
        const lines = index.split("\n").length;
        if (lines > INDEX_MAX_LINES) {
            say("MEMORY.md", `${String(lines)} lines (limit ${String(INDEX_MAX_LINES)}): the rest is not loaded`);
        }
        if (Buffer.byteLength(index) > INDEX_MAX_BYTES) {
            say("MEMORY.md", `over ${String(INDEX_MAX_BYTES)} bytes: the rest is not loaded`);
        }
        const linked = [...index.matchAll(/\]\(([^)#]+\.md)\)/g)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
        for (const link of linked) {
            if (!existsSync(join(dir, link)))
                say("MEMORY.md", `links to missing ${link}`);
        }
        for (const file of files) {
            if (!linked.includes(file))
                say(file, "not in MEMORY.md");
        }
    }
    const slugs = new Set(files.map((f) => f.slice(0, -3).replaceAll("_", "-").toLowerCase()));
    for (const file of files) {
        const text = readFileSync(join(dir, file), "utf8");
        const fm = frontmatter(text);
        if (!fm)
            say(file, "no frontmatter");
        else {
            if (!fm.name)
                say(file, "frontmatter: no name");
            if (!fm.description)
                say(file, "frontmatter: no description");
            else if (!/^["'>|]/.test(fm.description) &&
                /: | #/.test(fm.description)) {
                say(file, 'frontmatter: description needs quotes (": " breaks YAML)');
            }
            if (!TYPES.includes((fm.type ?? "").replace(/["']/g, ""))) {
                say(file, `frontmatter: type is ${fm.type ?? "missing"}, want one of ${TYPES.join("|")}`);
            }
        }
        const body = fm ? fm.body : text;
        for (const match of body.matchAll(/\[\[([\w-]+)\]\]/g)) {
            const link = match[1];
            if (link !== undefined &&
                !slugs.has(link.replaceAll("_", "-").toLowerCase())) {
                say(file, `dangling link [[${link}]]`);
            }
        }
        for (const match of body.matchAll(/\]\(([^)#:]+\.md)\)/g)) {
            const link = match[1];
            if (link !== undefined && !existsSync(join(dir, link)))
                say(file, `dangling link ${link}`);
        }
        if (Buffer.byteLength(text) > FILE_MAX_BYTES) {
            say(file, `${String(Buffer.byteLength(text))} bytes: likely an accreted log, split or cut it`);
        }
        const wording = body.match(APPEND);
        if (wording)
            say(file, `append-style wording "${wording[0]}": state the current fact instead`);
        if (repo) {
            for (const match of body.matchAll(/`((?:[\w.-]+\/)+[\w.-]+\.\w+)`/g)) {
                const path = match[1];
                if (path !== undefined && !existsSync(join(repo, path)))
                    say(file, `path not in ${repo}: ${path}`);
            }
        }
    }
    return out;
}
/** Discover existing auto-memory directories under the configured Claude home. */
export function defaultDirs(env = process.env) {
    const configured = env.CLAUDE_CONFIG_DIR;
    const root = join(configured !== undefined && configured.length > 0
        ? configured
        : join(homedir(), ".claude"), "projects");
    if (!existsSync(root))
        return [];
    return readdirSync(root)
        .map((p) => join(root, p, "memory"))
        .filter((dir) => existsSync(dir));
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    const args = process.argv.slice(2);
    let repo;
    const dirs = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--repo")
            repo = args[++i];
        else if (arg?.startsWith("-")) {
            console.error("usage: memory-lint.mjs [--repo <path>] [<memory-dir>...]");
            process.exit(2);
        }
        else if (arg !== undefined)
            dirs.push(arg);
    }
    const targets = dirs.length ? dirs : defaultDirs();
    const findings = targets.flatMap((dir) => lintDir(dir, { repo }));
    console.log(findings.length
        ? findings.join("\n")
        : `memory-lint: ${String(targets.length)} dir(s), no findings`);
}
