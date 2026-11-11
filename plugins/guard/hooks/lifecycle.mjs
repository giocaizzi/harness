// Branch lifecycle helpers (github-workflow, Branch lifecycle): the daily repo sweep started at session start, the
// warn-only stop reminder about unpushed work, and the notes handed to the agent on its next turn.
// Every function here fails open: an error, a missing tool or a timeout yields nothing and never throws.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync, } from "node:fs";
import { basename, dirname, join } from "node:path";
import { readDataFile } from "./data.mjs";
import { installedVersions } from "./stale.mjs";
const DAY_MS = 24 * 60 * 60 * 1000;
const CALL_TIMEOUT_MS = 3000;
const SMALL_FILE_BYTES = 8192;
const MAX_NOTES = 20;
const SWEEP_SCRIPT = join("skills", "host-hygiene", "scripts", "repo-sweep.mjs");
const SEMVER = /^\d+\.\d+\.\d+$/;
const REMINDED_AGENTS = /^(dev-tools:)?(driver|escalate)$/;
// Clutter thresholds of the fallback nudge.
const MAX_WORKTREES = 10;
const MAX_BRANCHES = 50;
const MAX_STASHES = 3;
export const defaultRunner = (cmd, args, cwd, timeoutMs) => {
    const r = spawnSync(cmd, args, {
        cwd,
        encoding: "utf8",
        timeout: timeoutMs,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
    });
    return { status: r.error ? null : r.status, stdout: r.stdout };
};
const git = (run, cwd, ...args) => {
    const r = run("git", args, cwd, CALL_TIMEOUT_MS);
    return r.status === 0 ? r.stdout.trim() : null;
};
const lines = (text) => (text ?? "").split("\n").filter((l) => l.trim() !== "");
function repoDirs(run, cwd) {
    const out = git(run, cwd, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir");
    const [gitDir, common] = lines(out);
    if (!gitDir || !common)
        return null;
    return { common, main: gitDir === common };
}
// The values every guard off switch reads as off (GUARD_LIFECYCLE, GUARD_PUSH_SCAN, ...).
export const OFF = /^(0|false|off)$/i;
const off = (env) => OFF.test(env.GUARD_LIFECYCLE ?? "");
function resolveScript(pluginRoot, cwd) {
    const versioned = SEMVER.test(basename(pluginRoot));
    const plugins = versioned
        ? dirname(dirname(pluginRoot))
        : dirname(pluginRoot);
    let dir = join(plugins, "dev-tools");
    if (versioned) {
        const version = installedVersions(pluginRoot, cwd).installed["dev-tools"];
        if (!version)
            return null;
        dir = join(dir, version);
    }
    const script = join(dir, SWEEP_SCRIPT);
    return existsSync(script) ? script : null;
}
function spawnDetached(script, repo) {
    const child = spawn(process.execPath, [script, "--auto", "--repo", repo], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
    });
    child.on("error", () => {
        // ignored: the next session starts the sweep again
    });
    child.unref();
}
const sweepDir = (common) => join(common, "sweep");
function writeSmallFile(file, text) {
    mkdirSync(dirname(file), { recursive: true });
    // temp file and rename: whatever sits at the path is replaced, never written through
    const tmp = `${file}.${String(process.pid)}.${randomBytes(4).toString("hex")}.tmp`;
    try {
        writeFileSync(tmp, text, { flag: "wx", mode: 0o600 });
        renameSync(tmp, file);
    }
    catch (e) {
        rmSync(tmp, { force: true });
        throw e;
    }
}
function readJson(file) {
    const text = readDataFile(file, SMALL_FILE_BYTES);
    if (text === null)
        return null;
    try {
        const v = JSON.parse(text);
        return typeof v === "object" && v !== null && !Array.isArray(v)
            ? v
            : null;
    }
    catch {
        return null;
    }
}
// A record time as a comparable string (an ISO string or an epoch number), or null.
const timeKey = (v) => typeof v === "string" || typeof v === "number" ? String(v) : null;
function readNudge(common) {
    const j = readJson(join(sweepDir(common), "nudge.json"));
    const time = timeKey(j?.time);
    return typeof j?.text === "string" && time !== null
        ? { text: j.text, time }
        : null;
}
// The sweep could not run: nudge when the repo is cluttered (3 cheap git calls), else clear an old nudge.
function writeFallbackNudge(run, cwd, common, now) {
    const worktrees = lines(git(run, cwd, "worktree", "list", "--porcelain")).filter((l) => l.startsWith("worktree ")).length;
    const branches = lines(git(run, cwd, "for-each-ref", "--format=%(refname)", "refs/heads")).length;
    const stashes = lines(git(run, cwd, "stash", "list")).length;
    const file = join(sweepDir(common), "nudge.json");
    if (worktrees <= MAX_WORKTREES &&
        branches <= MAX_BRANCHES &&
        stashes <= MAX_STASHES) {
        rmSync(file, { force: true });
        return;
    }
    const text = `This repo has ${String(worktrees)} worktrees, ${String(branches)} branches, ${String(stashes)} stashes; run host-hygiene's repo-sweep (dry run) and show the owner`;
    const old = readNudge(common);
    const time = old?.text === text ? old.time : new Date(now).toISOString();
    writeSmallFile(file, JSON.stringify({ time, text }));
}
// Starts dev-tools' repo-sweep.mjs --auto detached when the repo's daily stamp is stale; a no-op otherwise.
export function startSessionSweep(opts) {
    try {
        if (off(opts.env) || opts.registered)
            return;
        const run = opts.deps?.run ?? defaultRunner;
        const dirs = repoDirs(run, opts.cwd);
        if (!dirs?.main)
            return;
        const now = (opts.deps?.now ?? Date.now)();
        try {
            if (now - statSync(join(sweepDir(dirs.common), "stamp")).mtimeMs <
                DAY_MS) {
                return;
            }
        }
        catch {
            // no stamp yet: the sweep is due
        }
        try {
            const script = (opts.deps?.scriptFor ?? resolveScript)(opts.pluginRoot, opts.cwd);
            if (!script)
                throw new Error("no repo-sweep script");
            (opts.deps?.spawnSweep ?? spawnDetached)(script, opts.cwd);
        }
        catch {
            writeFallbackNudge(run, opts.cwd, dirs.common, now);
        }
    }
    catch {
        // a missed sweep changes nothing
    }
}
// The previous auto sweep's one-line summary, or a nudge when the sweep could not run and the repo is cluttered;
// null when there is nothing new to say for this repo.
export function sweepNotice(cwd, env, deps = {}) {
    try {
        if (off(env))
            return null;
        const dirs = repoDirs(deps.run ?? defaultRunner, cwd);
        if (!dirs)
            return null;
        const dir = sweepDir(dirs.common);
        const seen = readJson(join(dir, "noticed")) ?? {};
        const last = readJson(join(dir, "last.json"));
        const candidates = [];
        const lastTime = timeKey(last?.time);
        if (typeof last?.summary === "string" &&
            last.summary.trim() !== "" &&
            lastTime !== null) {
            candidates.push({
                key: "last",
                text: last.summary.trim().split("\n")[0] ?? "",
                time: lastTime,
            });
        }
        const nudge = readNudge(dirs.common);
        if (nudge)
            candidates.push({ key: "nudge", ...nudge });
        const next = candidates.find((c) => seen[c.key] !== c.time);
        if (!next)
            return null;
        writeSmallFile(join(dir, "noticed"), JSON.stringify({ ...seen, [next.key]: next.time }));
        return next.text;
    }
    catch {
        return null;
    }
}
function defaultBranch(run, cwd) {
    const ref = git(run, cwd, "symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD");
    if (ref)
        return ref.replace(/^origin\//, "");
    for (const b of ["main", "master"]) {
        if (git(run, cwd, "rev-parse", "--verify", "-q", `refs/remotes/origin/${b}`)) {
            return b;
        }
    }
    return null;
}
// The warn-only reminder for the cwd's current branch: unpushed commits, or pushed with no open PR.
export function lifecycleReminder(cwd, env, opts = {}) {
    try {
        if (off(env))
            return null;
        if (opts.agentType && !REMINDED_AGENTS.test(opts.agentType))
            return null;
        const run = opts.deps?.run ?? defaultRunner;
        const branch = git(run, cwd, "symbolic-ref", "--short", "-q", "HEAD");
        if (!branch)
            return null;
        if (!lines(git(run, cwd, "remote")).includes("origin"))
            return null;
        const head = git(run, cwd, "rev-parse", "HEAD");
        const countText = git(run, cwd, "rev-list", "--count", "HEAD", "--not", "--remotes");
        if (!head || countText === null)
            return null;
        const unpushed = Number(countText);
        if (!Number.isInteger(unpushed))
            return null;
        const key = `${branch}@${head}`;
        const trunk = defaultBranch(run, cwd);
        if (branch === trunk) {
            return unpushed > 0
                ? {
                    key,
                    message: `\`${branch}\` has ${String(unpushed)} local commit(s): push them where the repo allows direct commits; otherwise move them to a branch (\`wt\`).`,
                }
                : null;
        }
        if (unpushed > 0) {
            return {
                key,
                message: `\`${branch}\` has ${String(unpushed)} commit(s) origin does not have: push them (\`github-workflow\`, Branch lifecycle).`,
            };
        }
        const upstream = git(run, cwd, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}");
        if (!upstream || upstream === `origin/${trunk ?? ""}`)
            return null;
        const prs = run("gh", [
            "pr",
            "list",
            "--head",
            branch,
            "--state",
            "open",
            "--json",
            "number",
            "--limit",
            "1",
        ], cwd, CALL_TIMEOUT_MS);
        if (prs.status !== 0)
            return null;
        const parsed = JSON.parse(prs.stdout);
        if (!Array.isArray(parsed) || parsed.length > 0)
            return null;
        return {
            key,
            message: `\`${branch}\` is pushed but has no PR: open a draft PR (\`gh pr create --draft\`).`,
        };
    }
    catch {
        return null;
    }
}
const notesFile = (dataDir, session) => join(dataDir, "notes", `${session.replace(/[^\w-]/g, "_")}.json`);
function readNotes(file) {
    const text = readDataFile(file, SMALL_FILE_BYTES);
    if (text === null)
        return [];
    try {
        const v = JSON.parse(text);
        return Array.isArray(v)
            ? v.filter((n) => typeof n === "string")
            : [];
    }
    catch {
        return [];
    }
}
// Queue a note for the agent's next turn (stop hooks cannot add context without holding the stop).
export function queueAgentNote(dataDir, session, text) {
    try {
        if (!session)
            return;
        const file = notesFile(dataDir, session);
        const notes = readNotes(file);
        if (notes.includes(text))
            return;
        writeSmallFile(file, JSON.stringify([...notes, text].slice(-MAX_NOTES)));
    }
    catch {
        // a missed note changes nothing
    }
}
// Take (and clear) the notes queued for this session.
export function takeAgentNotes(dataDir, session) {
    try {
        if (!session)
            return [];
        const file = notesFile(dataDir, session);
        const notes = readNotes(file);
        rmSync(file, { force: true });
        return notes;
    }
    catch {
        return [];
    }
}
