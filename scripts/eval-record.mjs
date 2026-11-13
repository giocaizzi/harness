#!/usr/bin/env node
// Eval scoreboard: appends one JSON line per case of each `claude plugin eval` results dir to the plugin's committed
// evals/scores.jsonl, so runs can be compared without re-running them. Rows already recorded (same run and case) are
// skipped. Runbook: docs/skills.md (Evals).
//
//   node scripts/eval-record.mjs <plugin-dir> [results-dir...] [--commit <sha>] [--model <id>] [--since <iso>]
//     [--dirty auto|true|false]
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import YAML from "yaml";
const round = (n) => Math.round(n * 1e6) / 1e6;
const cost = (a) => (a.costUsd ?? 0) + (a.judgeCostUsd ?? 0);
/** One row per case of a results dir's aggregate. */
export function rows(agg, ctx) {
    const plugin = agg.suite.plugins[0];
    if (!plugin)
        throw new Error(`${ctx.run}: aggregate names no plugin`);
    return agg.cases.map((c) => {
        const arms = c.arms.with ?? [];
        return {
            run: ctx.run,
            date: agg.startedAt,
            commit: ctx.commit,
            ...(ctx.dirty === undefined ? {} : { dirty: ctx.dirty }),
            harness: "claude-code",
            harnessVersion: agg.claudeVersion,
            model: ctx.model,
            plugin: plugin.name,
            pluginVersion: plugin.version,
            case: c.name,
            tags: ctx.tags(c),
            runs: arms.map((a) => ({
                passed: a.passed,
                score: a.score,
                turns: a.turns ?? null,
                durationSeconds: a.durationSeconds ?? null,
                costUsd: round(cost(a)),
                error: a.error ?? null,
            })),
            passes: arms.filter((a) => a.passed).length,
            passRate: c.aggregates.passRate,
            score: c.aggregates.score,
            costUsd: round(arms.reduce((s, a) => s + cost(a), 0)),
        };
    });
}
/** The session model of the first trace that still exists (its `system`/`init` line), else null. */
export function traceModel(agg) {
    for (const c of agg.cases) {
        for (const a of c.arms.with ?? []) {
            if (!a.tracePath || !existsSync(a.tracePath))
                continue;
            for (const line of readFileSync(a.tracePath, "utf8").split("\n")) {
                if (!line.includes('"init"'))
                    continue;
                const e = JSON.parse(line);
                if (e.type === "system" &&
                    e.subtype === "init" &&
                    typeof e.model === "string")
                    return e.model;
            }
        }
    }
    return null;
}
/** Tags from the case's case.yaml, looked up under each root in turn; [] when none is found. */
export function caseTags(c, roots) {
    for (const root of roots) {
        const file = join(root, c.dir, "case.yaml");
        if (!existsSync(file))
            continue;
        const doc = YAML.parse(readFileSync(file, "utf8"));
        return Array.isArray(doc?.tags) ? doc.tags.map(String) : [];
    }
    return [];
}
/** Keys (`run/case`) of the rows already in a scores file. */
export function recorded(text) {
    const keys = new Set();
    for (const line of text.split("\n")) {
        if (!line.trim())
            continue;
        const r = JSON.parse(line);
        keys.add(`${r.run}/${r.case}`);
    }
    return keys;
}
export function parseArgs(argv) {
    const opts = {
        pluginDir: "",
        dirs: [],
        commit: null,
        model: null,
        since: null,
        dirty: null,
    };
    const positional = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i] ?? "";
        if (a === "--commit" ||
            a === "--model" ||
            a === "--since" ||
            a === "--dirty") {
            const v = argv[++i];
            if (!v)
                throw new Error(`${a} needs a value`);
            opts[a.slice(2)] = v;
        }
        else if (a.startsWith("--"))
            throw new Error(`unknown option ${a}`);
        else
            positional.push(a);
    }
    const [pluginDir, ...dirs] = positional;
    if (!pluginDir)
        throw new Error("usage: eval-record <plugin-dir> [results-dir...] [--commit <sha>] [--model <id>] [--since <iso>] [--dirty auto|true|false]");
    opts.pluginDir = pluginDir;
    opts.dirs = dirs;
    return opts;
}
const git = (dir, args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
/**
 * `auto`: whether tracked files under the plugin have uncommitted changes (results and the scoreboard excepted);
 * `true`/`false` as given; null: unknown, so the field is left out.
 */
export function resolveDirty(pluginDir, dirty) {
    if (dirty === null)
        return undefined;
    if (dirty === "true" || dirty === "false")
        return dirty === "true";
    if (dirty !== "auto")
        throw new Error(`--dirty takes auto, true or false, not ${dirty}`);
    return (git(pluginDir, [
        "status",
        "--porcelain",
        "--untracked-files=no",
        "--",
        ".",
        ":(exclude)evals/results",
        ":(exclude)evals/scores.jsonl",
    ]) !== "");
}
/** Appends the rows of each results dir not yet recorded; returns the number of rows written. */
export function record(opts, log = console.log) {
    const resultsRoot = join(opts.pluginDir, "evals", "results");
    const dirs = opts.dirs.length > 0
        ? opts.dirs
        : existsSync(resultsRoot)
            ? readdirSync(resultsRoot)
                .sort()
                .map((d) => join(resultsRoot, d))
                .filter((d) => statSync(d).isDirectory())
            : [];
    const commit = git(opts.pluginDir, [
        "rev-parse",
        "--verify",
        `${opts.commit ?? "HEAD"}^{commit}`,
    ]);
    const dirty = resolveDirty(opts.pluginDir, opts.dirty);
    const out = join(opts.pluginDir, "evals", "scores.jsonl");
    const seen = recorded(existsSync(out) ? readFileSync(out, "utf8") : "");
    const name = basename(opts.pluginDir.replace(/[\\/]+$/, ""));
    let written = 0;
    for (const dir of dirs) {
        const file = join(dir, "aggregate-result.json");
        if (!existsSync(file))
            continue;
        const agg = JSON.parse(readFileSync(file, "utf8"));
        if (opts.since && agg.startedAt < opts.since)
            continue;
        const run = basename(dir.replace(/[\\/]+$/, ""));
        if (agg.suite.plugins[0]?.name !== name)
            throw new Error(`${run}: results are for ${agg.suite.plugins[0]?.name ?? "no plugin"}, not ${name}`);
        const fresh = agg.cases.filter((c) => !seen.has(`${run}/${c.name}`));
        if (fresh.length === 0)
            continue;
        const model = traceModel(agg) ?? opts.model;
        if (!model)
            throw new Error(`${run}: no trace left to read the model from; pass --model <exact model id>`);
        const lines = rows({ ...agg, cases: fresh }, {
            run,
            commit,
            dirty,
            model,
            tags: (c) => caseTags(c, [agg.suite.root, opts.pluginDir]),
        });
        appendFileSync(out, lines.map((r) => JSON.stringify(r) + "\n").join(""));
        for (const r of lines)
            seen.add(`${r.run}/${r.case}`);
        written += lines.length;
        log(`${run}: ${String(lines.length)} row(s) for ${model} at ${commit.slice(0, 7)}`);
    }
    log(`${String(written)} row(s) appended to ${out}`);
    return written;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    try {
        record(parseArgs(process.argv.slice(2)));
    }
    catch (e) {
        console.error(`eval-record: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
    }
}
