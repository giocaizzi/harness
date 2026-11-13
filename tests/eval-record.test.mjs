import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDirty, parseArgs, record, } from "../scripts/eval-record.mjs";
const quiet = () => undefined;
/** A git repo with plugins/acme (one case) and a results dir per given startedAt. */
function fixture(runs, plugin = "acme") {
    const root = mkdtempSync(join(tmpdir(), "eval-record-"));
    const git = (...args) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
        encoding: "utf8",
        env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
        },
    }).trim();
    git("init", "-q");
    const pluginDir = join(root, "plugins", "acme");
    mkdirSync(join(pluginDir, "evals", "app-trigger"), { recursive: true });
    writeFileSync(join(pluginDir, "evals", "app-trigger", "case.yaml"), "name: app-trigger\ntags: [trigger, smoke]\n");
    git("add", ".");
    git("commit", "-qm", "init");
    const sha = git("rev-parse", "HEAD");
    for (const r of runs) {
        const dir = join(pluginDir, "evals", "results", r.id);
        mkdirSync(dir, { recursive: true });
        const trace = join(dir, "trace.jsonl");
        if (r.trace)
            writeFileSync(trace, `{"type":"system","subtype":"init","model":"claude-test-1"}\n{"type":"assistant"}\n`);
        const arm = (passed) => ({
            passed,
            score: passed ? 1 : 0,
            turns: 4,
            durationSeconds: 20,
            error: passed ? null : "boom",
            costUsd: 0.1,
            judgeCostUsd: 0.01,
            tracePath: r.trace ? trace : "/nonexistent/trace.jsonl",
        });
        const agg = {
            claudeVersion: "9.9.9",
            startedAt: r.startedAt,
            suite: { root: pluginDir, plugins: [{ name: plugin, version: "1.2.3" }] },
            cases: [
                {
                    name: "app-trigger",
                    dir: "evals/app-trigger",
                    arms: { with: [arm(true), arm(false), arm(true)] },
                    aggregates: { score: 2 / 3, passRate: 2 / 3 },
                },
            ],
        };
        writeFileSync(join(dir, "aggregate-result.json"), JSON.stringify(agg));
    }
    const read = () => readFileSync(join(pluginDir, "evals", "scores.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
    return { pluginDir, sha, read, git };
}
void test("parseArgs", () => {
    assert.deepEqual(parseArgs([
        "plugins/a",
        "r1",
        "--commit",
        "abc",
        "--model",
        "m",
        "--since",
        "2026",
    ]), {
        pluginDir: "plugins/a",
        dirs: ["r1"],
        commit: "abc",
        model: "m",
        since: "2026",
        dirty: null,
    });
    assert.throws(() => parseArgs([]), /usage/);
    assert.throws(() => parseArgs(["p", "--model"]), /needs a value/);
    assert.throws(() => parseArgs(["p", "--bogus", "x"]), /unknown option/);
});
void test("records one row per case, model from the trace, and is idempotent", () => {
    const f = fixture([
        {
            id: "2026-01-01T00-00-00-000Z",
            startedAt: "2026-01-01T00:00:00.000Z",
            trace: true,
        },
    ]);
    const opts = {
        pluginDir: f.pluginDir,
        dirs: [],
        commit: null,
        model: "ignored-when-trace",
        since: null,
        dirty: null,
    };
    assert.equal(record(opts, quiet), 1);
    assert.deepEqual(f.read(), [
        {
            run: "2026-01-01T00-00-00-000Z",
            date: "2026-01-01T00:00:00.000Z",
            commit: f.sha,
            harness: "claude-code",
            harnessVersion: "9.9.9",
            model: "claude-test-1",
            plugin: "acme",
            pluginVersion: "1.2.3",
            case: "app-trigger",
            tags: ["trigger", "smoke"],
            runs: [
                {
                    passed: true,
                    score: 1,
                    turns: 4,
                    durationSeconds: 20,
                    costUsd: 0.11,
                    error: null,
                },
                {
                    passed: false,
                    score: 0,
                    turns: 4,
                    durationSeconds: 20,
                    costUsd: 0.11,
                    error: "boom",
                },
                {
                    passed: true,
                    score: 1,
                    turns: 4,
                    durationSeconds: 20,
                    costUsd: 0.11,
                    error: null,
                },
            ],
            passes: 2,
            passRate: 2 / 3,
            score: 2 / 3,
            costUsd: 0.33,
        },
    ]);
    assert.equal(record(opts, quiet), 0);
    assert.equal(f.read().length, 1);
});
void test("without a trace, needs --model; --commit resolves a short sha; --since skips older runs", () => {
    const f = fixture([
        { id: "old", startedAt: "2026-01-01T00:00:00.000Z" },
        { id: "new", startedAt: "2026-02-01T00:00:00.000Z" },
    ]);
    const base = {
        pluginDir: f.pluginDir,
        dirs: [],
        commit: f.sha.slice(0, 7),
        model: null,
        since: "2026-01-15T00:00:00Z",
        dirty: null,
    };
    assert.throws(() => record(base, quiet), /pass --model/);
    assert.equal(record({ ...base, model: "claude-test-2" }, quiet), 1);
    const [row] = f.read();
    assert.equal(row?.run, "new");
    assert.equal(row.model, "claude-test-2");
    assert.equal(row.commit, f.sha);
});
void test("refuses results of another plugin", () => {
    const f = fixture([{ id: "r", startedAt: "2026-01-01T00:00:00.000Z", trace: true }], "other");
    assert.throws(() => record({
        pluginDir: f.pluginDir,
        dirs: [],
        commit: null,
        model: null,
        since: null,
        dirty: null,
    }, quiet), /for other, not acme/);
});
void test("dirty: auto reads tracked plugin changes, except results and the scoreboard; unknown leaves it out", () => {
    const f = fixture([
        { id: "r", startedAt: "2026-01-01T00:00:00.000Z", trace: true },
    ]);
    assert.equal(resolveDirty(f.pluginDir, null), undefined);
    assert.equal(resolveDirty(f.pluginDir, "true"), true);
    assert.throws(() => resolveDirty(f.pluginDir, "maybe"), /auto, true or false/);
    assert.equal(resolveDirty(f.pluginDir, "auto"), false);
    const opts = {
        pluginDir: f.pluginDir,
        dirs: [],
        commit: null,
        model: null,
        since: null,
        dirty: null,
    };
    record(opts, quiet);
    assert.equal("dirty" in (f.read()[0] ?? {}), false);
    f.git("add", ".");
    f.git("commit", "-qm", "scores");
    appendFileSync(join(f.pluginDir, "evals", "scores.jsonl"), "{}\n");
    assert.equal(resolveDirty(f.pluginDir, "auto"), false, "scores.jsonl and results do not count");
    writeFileSync(join(f.pluginDir, "evals", "app-trigger", "case.yaml"), "name: app-trigger\ntags: [trigger]\n");
    assert.equal(resolveDirty(f.pluginDir, "auto"), true);
});
