// Shared by tests/wait-pr-sh.test.mjs and tests/wait-pr-ps1.test.mjs: the tests of
// plugins/dev-tools/skills/land/scripts/wait-pr.{sh,ps1} against a scripted `gh` on PATH. The .sh runs on
// macOS/Linux, the .ps1 on Windows (CI's windows-scripts job), like the scripts themselves. Each test spawns
// its own script, gh shim and temp dir, so a file runs them concurrently (`CONCURRENCY`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync, } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
const scripts = fileURLToPath(new URL("../plugins/dev-tools/skills/land/scripts/", import.meta.url));
// The shim: each `gh pr view` takes the next step (the last one repeats); `gh pr checks` answers from the same step.
// A step is { view: {state, mergeStateStatus} | 'error' | 'hang' | 'stubborn', checks?: [{name, bucket, link}] | 'hang' | 'stubborn',
// delay?: ms before answering }; no checks means none reported, 'stubborn' hangs and ignores SIGTERM.
// `--jq` goes through jq, as gh would apply it. Each call appends its pid to <steps>.pids.
const shim = `
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const [, , cmd, sub, ...rest] = process.argv
const steps = JSON.parse(readFileSync(process.env.SHIM_STEPS, 'utf8'))
const counter = process.env.SHIM_STEPS + '.n'
let n = 0
try { n = Number(readFileSync(counter, 'utf8')) } catch {}
appendFileSync(process.env.SHIM_STEPS + '.log', sub + '\\n')
appendFileSync(process.env.SHIM_STEPS + '.pids', process.pid + '\\n')
if (sub === 'view') writeFileSync(counter, String(++n))
const step = steps[Math.min(Math.max(n, 1), steps.length) - 1]
const jq = rest.indexOf('--jq')
const out = (data, code) => {
  let text = JSON.stringify(data)
  if (jq >= 0) text = spawnSync('jq', ['-r', rest[jq + 1]], { input: text, encoding: 'utf8' }).stdout.replace(/\\n$/, '')
  if (text) process.stdout.write(text + '\\n')
  process.exit(code)
}
if (cmd !== 'pr') process.exit(64)
if (step[sub] === 'stubborn') process.on('SIGTERM', () => {})
if (step[sub] === 'hang' || step[sub] === 'stubborn') setTimeout(() => {}, 60000)
else setTimeout(() => {
if (sub === 'view') {
  if (step.view === 'error') { process.stderr.write('GraphQL: Could not resolve to a PullRequest\\n'); process.exit(1) }
  out(step.view, 0)
}
if (sub === 'checks') {
  if (!step.checks) { process.stderr.write("no checks reported on the 'x' branch\\n"); process.exit(1) }
  const b = step.checks.map((c) => c.bucket)
  out(step.checks, b.includes('fail') || b.includes('cancel') ? 1 : b.includes('pending') ? 8 : 0)
}
process.exit(64)
}, step.delay ?? 0)
`;
const bin = mkdtempSync(join(tmpdir(), "wait-pr-bin-"));
writeFileSync(join(bin, "shim.mjs"), shim);
// SHIM_NOEXEC keeps the shell as gh's process, with node as its child, like a wrapper that forks.
writeFileSync(join(bin, "gh"), `#!/bin/sh\nif [ -n "$SHIM_NOEXEC" ]; then node "$(dirname "$0")/shim.mjs" "$@"; else exec node "$(dirname "$0")/shim.mjs" "$@"; fi\n`);
chmodSync(join(bin, "gh"), 0o755);
writeFileSync(join(bin, "gh.cmd"), '@node "%~dp0shim.mjs" %*\r\n');
export const win = process.platform === "win32";
// Tests at once per file: most of each one is waiting on a 1-3 s deadline and its 5 s grace, not CPU.
export const CONCURRENCY = 4;
const runners = {
    sh: (args) => ["bash", [join(scripts, "wait-pr.sh"), ...args]],
    ps1: (args) => [
        "pwsh",
        ["-NoProfile", "-File", join(scripts, "wait-pr.ps1"), ...args],
    ],
};
const open = (mergeStateStatus = "BLOCKED", checks) => ({
    view: { state: "OPEN", mergeStateStatus },
    checks,
});
const check = (name, bucket) => ({
    name,
    bucket,
    link: `https://ci.example/${name.replace(/ /g, "-")}`,
});
export function setup(kind, steps, args = [], extraEnv = {}) {
    const dir = mkdtempSync(join(tmpdir(), "wait-pr-"));
    const file = join(dir, "steps.json");
    writeFileSync(file, JSON.stringify(steps));
    const runner = runners[kind];
    assert.ok(runner, `unknown runner ${kind}`);
    const [exe, argv] = runner(["12", ...args]);
    const env = {
        ...process.env,
        PATH: bin + delimiter + (process.env.PATH ?? ""),
        SHIM_STEPS: file,
        SHIM_NOEXEC: "",
        WAIT_PR_INTERVAL: "",
        WAIT_PR_TIMEOUT: "",
        ...extraEnv,
    };
    return { file, exe, argv, env };
}
export const pids = (file) => existsSync(file + ".pids")
    ? readFileSync(file + ".pids", "utf8")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number)
    : [];
const alive = (pid) => {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        return e.code === "EPERM";
    }
};
// The gh calls' pids still running a moment after the script ended (a killed orphan needs time to be reaped,
// longer on a loaded runner).
export async function survivors(file) {
    for (let i = 0; i < 50; i++) {
        if (pids(file).filter(alive).length === 0)
            return [];
        await new Promise((r) => setTimeout(r, 100));
    }
    return pids(file).filter(alive);
}
// Spawns the script with its gh shim and returns the outcome, stderr, stdout and the gh subcommands called.
export function run(kind, steps, args = ["--interval", "1"], extraEnv = {}) {
    const { file, exe, argv, env } = setup(kind, steps, args, extraEnv);
    return new Promise((resolve) => {
        const started = Date.now();
        const child = spawn(exe, argv, { env, timeout: 30000 });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => {
            out += d.toString("utf8");
        });
        child.stderr.on("data", (d) => {
            err += d.toString("utf8");
        });
        child.on("close", (code) => {
            const calls = existsSync(file + ".log")
                ? readFileSync(file + ".log", "utf8")
                    .trim()
                    .split(/\n/)
                    .filter(Boolean)
                : [];
            const secs = (Date.now() - started) / 1000;
            resolve({
                code,
                out: out.replace(/\r\n/g, "\n"),
                err,
                file,
                calls,
                secs,
            });
        });
    });
}
// Tests shared by wait-pr.sh and wait-pr.ps1.
export function commonTests(kind) {
    void test(`${kind}: merged exits 0 after the open polls`, async () => {
        const r = await run(kind, [
            open("BLOCKED", [check("check", "pending")]),
            { view: { state: "MERGED", mergeStateStatus: "UNKNOWN" } },
        ]);
        assert.equal(r.code, 0, r.err);
        assert.match(r.out, /PR 12 merged/);
    });
    void test(`${kind}: closed without merging exits 1`, async () => {
        const r = await run(kind, [
            open(),
            { view: { state: "CLOSED", mergeStateStatus: "UNKNOWN" } },
        ]);
        assert.equal(r.code, 1, r.err);
        assert.match(r.out, /closed without merging/);
    });
    void test(`${kind}: a failed required check exits 3 with its name and link`, async () => {
        const r = await run(kind, [
            open("BLOCKED", [
                check("lint", "pass"),
                check("e2e tests", "fail"),
                check("build", "pending"),
            ]),
        ]);
        assert.equal(r.code, 3, r.err);
        assert.match(r.out, /required check failed\n {2}e2e tests https:\/\/ci\.example\/e2e-tests\n$/);
    });
    void test(`${kind}: a cancelled required check exits 3`, async () => {
        const r = await run(kind, [open("BLOCKED", [check("check", "cancel")])]);
        assert.equal(r.code, 3, r.err);
        assert.match(r.out, /check https:\/\/ci\.example\/check/);
    });
    void test(`${kind}: BEHIND and DIRTY exit 4`, async () => {
        const behind = await run(kind, [open("BEHIND", [check("check", "pass")])]);
        assert.equal(behind.code, 4, behind.err);
        assert.match(behind.out, /behind its base/);
        const dirty = await run(kind, [open("DIRTY")]);
        assert.equal(dirty.code, 4, dirty.err);
        assert.match(dirty.out, /merge conflict/);
    });
    const blocked = open("BLOCKED", [
        check("check", "pending"),
        check("Validate PR title", "pending"),
    ]);
    for (const [name, step] of [
        ["", blocked],
        [" and a gh that takes 0.3 s", { ...blocked, delay: 300 }],
    ]) {
        void test(`${kind}: no outcome${name} exits 124 at the timeout, naming no call, one call pair per poll`, async () => {
            const r = await run(kind, [step], ["--interval", "1", "--timeout", "3"]);
            assert.equal(r.code, 124, r.err);
            assert.match(r.out, /^PR 12: timed out after 3s, state OPEN, mergeStateStatus BLOCKED, pending required checks: check,Validate PR title\n$/);
            assert.match(r.calls.join(","), /^view,checks(,view,checks)*$/);
        });
    }
    for (const [what, step] of [
        ["gh pr view", { view: "hang" }],
        ["gh pr checks", open("BLOCKED", "hang")],
    ]) {
        void test(`${kind}: a hung ${what} is killed after the deadline and named`, async () => {
            const r = await run(kind, [step], ["--interval", "1", "--timeout", "1"]);
            assert.equal(r.code, 124, r.err);
            assert.match(r.out, new RegExp(`timed out after 1s, .*\\(${what} did not return\\)\n$`));
            assert.ok(r.secs < 15, `took ${String(r.secs)}s`);
        });
    }
    void test(`${kind}: a hung gh that forks and ignores SIGTERM is killed with its children`, async () => {
        const r = await run(kind, [{ view: "stubborn" }], ["--interval", "1", "--timeout", "1"], {
            SHIM_NOEXEC: "1",
        });
        assert.equal(r.code, 124, r.err);
        assert.match(r.out, /\(gh pr view did not return\)/);
        assert.ok(r.secs < 15, `took ${String(r.secs)}s`);
        assert.deepEqual(await survivors(r.file), []);
    });
    void test(`${kind}: without flags the script enforces its own deadline (WAIT_PR_TIMEOUT, default 5400 s)`, async () => {
        const r = await run(kind, [open()], [], {
            WAIT_PR_TIMEOUT: "1",
            WAIT_PR_INTERVAL: "1",
        });
        assert.equal(r.code, 124, r.err);
        assert.match(r.out, /timed out after 1s/);
        const src = readFileSync(join(scripts, `wait-pr.${kind}`), "utf8");
        assert.match(src, kind === "sh"
            ? /timeout=\$\{WAIT_PR_TIMEOUT:-5400\}/
            : /\$env:WAIT_PR_TIMEOUT \} else \{ '5400' \}/);
    });
    void test(`${kind}: gh failing 3 polls in a row exits 5 with its error`, async () => {
        const r = await run(kind, [{ view: "error" }]);
        assert.equal(r.code, 5);
        assert.match(r.err, /failed 3 times in a row/);
        assert.match(r.err, /Could not resolve/);
    });
    void test(`${kind}: a transient gh error and a PR without checks keep waiting`, async () => {
        const r = await run(kind, [
            { view: "error" },
            open("BLOCKED"),
            { view: "error" },
            { view: { state: "MERGED", mergeStateStatus: "UNKNOWN" } },
        ]);
        assert.equal(r.code, 0, r.err);
    });
    void test(`${kind}: bad arguments exit 2`, async () => {
        assert.equal((await run(kind, [open()], ["--interval"])).code, 2);
        assert.equal((await run(kind, [open()], ["--timeout", "soon"])).code, 2);
        for (const bad of [
            "09",
            "08",
            "",
            "0",
            "-5",
            "1.5",
            " 5",
            "99999999999999999999",
            "86401",
        ]) {
            assert.equal((await run(kind, [open()], ["--timeout", bad])).code, 2, `--timeout '${bad}'`);
        }
        for (const bad of ["08", "", "0", "3601"]) {
            assert.equal((await run(kind, [open()], ["--interval", bad, "--timeout", "5"])).code, 2, `--interval '${bad}'`);
        }
        for (const bad of ["09", "5\n", "5\n6"]) {
            assert.equal((await run(kind, [open()], [], { WAIT_PR_TIMEOUT: bad })).code, 2, `WAIT_PR_TIMEOUT=${JSON.stringify(bad)}`);
        }
        assert.equal((await run(kind, [open()], ["13"])).code, 2);
    });
}
