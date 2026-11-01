// A group run's result: `tasks` (schema 3) checked by check-result and written by write-result.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = join(repo, "plugins/factory/skills/ticket-run/scripts");
const WRITE = join(SCRIPTS, "write-result.mjs");
const FIXTURES = join(repo, "tests/fixtures/factory/result");
// A runtime's FACTORY_* variables must not reach the checker calls that read process.env.
for (const k of Object.keys(process.env)) {
    if (k.startsWith("FACTORY_"))
        Reflect.deleteProperty(process.env, k);
}
const checker = async () => {
    return (await import(pathToFileURL(join(SCRIPTS, "check-result.mjs")).href));
};
const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
const files = readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".json"))
    .sort();
const validFiles = files.filter((f) => f.startsWith("valid-"));
const invalidFiles = files.filter((f) => f.startsWith("invalid-"));
// The first error each invalid fixture must raise.
const EXPECTED = {
    "tasks-schema2": /tasks needs schema 3/,
    "schema3-no-tasks": /schema 3 needs tasks/,
    "empty-tasks": /tasks must be a non-empty array/,
    "lead-not-first": /tasks\[0\].*lead.*first/,
    "duplicate-ticket": /tasks\[1\].*listed twice/,
    "unknown-outcome": /tasks\[1\].*outcome must be one of/,
    "extra-key": /tasks\[1\].*"note" not allowed/,
    "done-with-reason": /tasks\[1\].*reason must be "" when done/,
    "parked-no-code": /tasks\[1\].*reason_code must be .*when parked/,
    "released-no-reason": /tasks\[1\].*reason must be a non-empty string when released/,
    "link-mismatch": /tasks\[1\].*pr_link must be "closes"/,
    "released-with-link": /tasks\[2\]: pr_link must be null when released/,
    "link-without-pr": /tasks\[0\].*pr_link must be null when parked without a pr/,
    "no-done-with-pr": /tasks: no done entry, so pr must be null/,
    "no-done-end-done": /tasks: no done entry, so end_state must not be done/,
    "turns-negative": /tasks\[1\]: turns must be a non-negative integer, got -1/,
    "turns-fraction": /tasks\[1\]: turns must be a non-negative integer, got 2.5/,
    "turns-string": /tasks\[1\]: turns must be a non-negative integer/,
    "done-without-pr": /tasks: a done entry needs pr/,
    "parked-member-end-done": /tasks: the members' outcomes \["done","parked","released"\] allow end_state parked at most, got "done"/,
    "all-released-end-parked": /tasks: the members' outcomes \["released","released"\] allow end_state failed at most, got "parked"/,
    "all-done-parked-no-code": /tasks: every member finished, so a parked run needs the reason_code it waits on \(such as merge_gate\), got null/,
};
void test("group result: the valid fixtures pass the checker", async () => {
    const { resultErrors } = await checker();
    assert.equal(validFiles.length, 8);
    for (const f of validFiles)
        assert.deepEqual(resultErrors(fixture(f), {}), [], f);
});
void test("group result: every invalid fixture fails with its own error, and the map covers exactly the files", async () => {
    const { resultErrors } = await checker();
    assert.deepEqual(invalidFiles.map((f) => f.slice("invalid-".length, -".json".length)).sort(), Object.keys(EXPECTED).sort());
    for (const f of invalidFiles) {
        const errors = resultErrors(fixture(f), {});
        const slug = f.slice("invalid-".length, -".json".length);
        const expectedRe = EXPECTED[slug];
        assert.ok(expectedRe, `missing expected regexp for ${slug}`);
        assert.ok(errors.some((e) => expectedRe.test(e)), `${f}: ${JSON.stringify(errors)}`);
    }
});
void test("group result: schema 2 or 3 only, and handoff is a reason code", async () => {
    const { coreErrors, REASON_CODES, OUTCOMES, PR_LINKS } = await checker();
    const result = fixture("valid-single.json");
    assert.deepEqual(coreErrors({ ...result, schema: 3 }, {}), []);
    assert.match(coreErrors({ ...result, schema: 4 }, {})[0] ?? "", /schema must be 2, or 3 with tasks, got 4/);
    assert.deepEqual(REASON_CODES.slice(-2), ["handoff", "takeover"]);
    // handoff is a member's park code: never the run's own.
    for (const schema of [2, 3]) {
        assert.match(coreErrors({
            ...result,
            schema,
            end_state: "parked",
            reason: "x",
            reason_code: "handoff",
        }, {})[0] ?? "", /handoff belongs only in a tasks entry/);
    }
    assert.deepEqual([OUTCOMES, PR_LINKS], [
        ["done", "parked", "released"],
        ["closes", "refs"],
    ]);
});
// Run-file fixtures sit in a subdirectory, so the map above still covers exactly the result fixtures.
const RUN_FILE = join(FIXTURES, "runfiles/valid-group-all-outcomes.json");
void test("group result: with FACTORY_RUN_FILE the tasks are the run file members, exactly and in order", async () => {
    const { resultErrors } = await checker();
    const result = fixture("valid-group-all-outcomes.json");
    const env = { FACTORY_RUN_FILE: RUN_FILE };
    assert.deepEqual(resultErrors(result, env), []);
    const swap = (t) => ({ ...result, tasks: t });
    const [a, b, c] = result.tasks ?? [];
    assert.ok(a && b && c);
    const differ = /tasks: tickets .* differ from the run file's members .*, in that order/;
    assert.match(resultErrors(swap([a, c, b]), env).join("\n"), differ);
    assert.match(resultErrors(swap([a, b]), env).join("\n"), differ);
    assert.match(resultErrors(swap([a, b, c, { ...c, ticket: "acme/app#99" }]), env).join("\n"), differ);
    assert.match(resultErrors(swap([a, b, { ...c, ticket: "ACME/app#14" }]), env).join("\n"), differ);
    // unset or blank: no check.
    assert.deepEqual(resultErrors(swap([a, c, b]), {}).filter((e) => differ.test(e)), []);
    assert.deepEqual(resultErrors(swap([a, c, b]), { FACTORY_RUN_FILE: "  " }).filter((e) => differ.test(e)), []);
});
void test("group result: with FACTORY_RUN_FILE set, a result without tasks fails unless the run stopped at the gate", async () => {
    const { resultErrors } = await checker();
    const single = fixture("valid-single.json");
    const message = "tasks: FACTORY_RUN_FILE is set, so this group run's result needs tasks (schema 3); only a stop at the gate, with pr null, leaves them out";
    const needs = new RegExp(`^${message.replace(/[()]/g, "\\$&")}$`);
    const gate = [
        {
            name: "gate",
            started_at: "2026-10-25T09:00:00Z",
            ended_at: "2026-10-25T09:01:00Z",
        },
    ];
    for (const env of [
        { FACTORY_RUN_FILE: RUN_FILE },
        { FACTORY_RUN_FILE: "/nonexistent/run.json" },
    ]) {
        assert.deepEqual(resultErrors(single, env), [message]);
        // Not a gate stop: a run past the gate, or a done one that ran the gate alone.
        assert.match(resultErrors({
            ...single,
            end_state: "parked",
            reason: "x",
            reason_code: "question",
            pr: null,
        }, env).join("\n"), needs);
        assert.match(resultErrors({ ...single, phases: gate }, env).join("\n"), needs);
        // A gate stop opens nothing: one that carries a PR is not exempt.
        assert.match(resultErrors({
            ...single,
            end_state: "failed",
            reason: "refuse: not approved",
            reason_code: "auth",
            phases: gate,
        }, env).join("\n"), needs);
        // A stop at the gate worked no member: no tasks, and the run file is not read.
        assert.deepEqual(resultErrors({
            ...single,
            end_state: "failed",
            reason: "refuse: not approved",
            reason_code: "auth",
            pr: null,
            phases: gate,
        }, env), []);
        const noPr = { ...single };
        delete noPr.pr;
        assert.deepEqual(resultErrors({
            ...noPr,
            end_state: "failed",
            reason: "refuse: not approved",
            reason_code: "auth",
            phases: gate,
        }, env), []);
    }
    assert.deepEqual(resultErrors(single, {}), []);
    assert.deepEqual(resultErrors(single, { FACTORY_RUN_FILE: " " }), []);
});
void test("group result: the members bound end_state from above; a stop of the whole run may end it lower", async () => {
    const { groupEndState, resultErrors } = await checker();
    const cases = [
        [["done"], "done"],
        [["done", "released"], "done"],
        [["done", "done"], "done"],
        [["done", "parked"], "parked"],
        [["parked", "released"], "parked"],
        [["done", "parked", "released"], "parked"],
        [["released"], "failed"],
        [["released", "released"], "failed"],
    ];
    for (const [outcomes, want] of cases)
        assert.equal(groupEndState(outcomes), want, outcomes.join());
    const base = fixture("valid-group-all-outcomes.json");
    const pr = "https://github.com/acme/app/pull/20";
    const entry = (outcome, n, hasPr) => ({
        ticket: `acme/app#${String(n)}`,
        outcome,
        reason: outcome === "done" ? "" : "x",
        reason_code: outcome === "parked" ? "question" : null,
        pr_link: !hasPr || outcome === "released"
            ? null
            : outcome === "done"
                ? "closes"
                : "refs",
    });
    const group = (outcomes, end_state, reason_code = null) => {
        const hasPr = outcomes.includes("done");
        return {
            ...base,
            end_state,
            reason: end_state === "done" ? "" : "x",
            reason_code: end_state === "done" ? null : reason_code,
            pr: hasPr ? pr : null,
            tasks: outcomes.map((o, i) => entry(o, 12 + i, hasPr)),
        };
    };
    // Allowed: done only at the bound done; parked at the bound done (with the run's code) or parked; failed and the
    // runtime's or budget's stops at every bound.
    const allowed = {
        done: ["done", "parked", "failed", "budget_reached", "halted"],
        parked: ["parked", "failed", "budget_reached", "halted"],
        failed: ["failed", "budget_reached", "halted"],
    };
    for (const [outcomes, bound] of cases) {
        const allowedEnd = allowed[bound] ?? [];
        for (const end of [
            "done",
            "parked",
            "failed",
            "budget_reached",
            "halted",
        ]) {
            const errors = resultErrors(group(outcomes, end, end === "parked"
                ? "merge_gate"
                : end === "budget_reached"
                    ? "budget"
                    : null), {});
            if (allowedEnd.includes(end))
                assert.deepEqual(errors, [], `${outcomes.join(",")} as ${end}`);
            else
                assert.ok(errors.length > 0, `${outcomes.join(",")} as ${end}`);
        }
    }
    // Every member finished and the run parks as a whole: it names what it waits on.
    assert.match(resultErrors(group(["done", "done"], "parked", null), {}).join("\n"), /a parked run needs the reason_code it waits on/);
    assert.deepEqual(resultErrors(group(["done", "parked"], "parked", null), {}), []);
    // The loopholes stay closed.
    const probes = [
        ["all released, done", { ...group(["released", "released"], "done"), pr }],
        [
            "a done member, pr null",
            { ...group(["done", "done"], "done"), pr: null },
        ],
        ["a parked member, done", group(["done", "parked"], "done")],
        ["empty tasks", { ...group(["done"], "done"), tasks: [] }],
        [
            "a ticket twice",
            (() => {
                const g = group(["done", "done"], "done");
                const t0 = g.tasks?.[0];
                const t1 = g.tasks?.[1];
                if (t0 && t1)
                    t1.ticket = t0.ticket;
                return g;
            })(),
        ],
        ["schema 2 with tasks", { ...group(["done"], "done"), schema: 2 }],
        [
            "a released member with a pr_link",
            (() => {
                const g = group(["done", "released"], "done");
                const t1 = g.tasks?.[1];
                if (t1)
                    t1.pr_link = "refs";
                return g;
            })(),
        ],
    ];
    for (const [name, r] of probes)
        assert.ok(resultErrors(r, {}).length > 0, name);
});
void test("group result: a run file that cannot be used fails closed", async () => {
    const { resultErrors } = await checker();
    const result = fixture("valid-group-all-outcomes.json");
    const dir = mkdtempSync(join(tmpdir(), "runfile-"));
    try {
        const put = (name, text) => {
            const p = join(dir, name);
            writeFileSync(p, text);
            return p;
        };
        const cases = [
            [join(dir, "missing.json"), /no such file/],
            [put("bad.json", "{"), /not valid JSON/],
            [put("nomembers.json", "{}"), /no members list/],
            [put("null.json", "null"), /no members list/],
            [put("empty.json", '{"members":[]}'), /no members list/],
            [put("badticket.json", '{"members":[{"ticket":1}]}'), /no members list/],
            [dir, /cannot read \(EISDIR\)/],
        ];
        for (const [path, why] of cases) {
            const errors = resultErrors(result, { FACTORY_RUN_FILE: path });
            assert.ok(errors.some((e) => e.startsWith("tasks: cannot check against the run file ") &&
                why.test(e)), `${path}: ${errors.join(" | ")}`);
        }
        assert.deepEqual(resultErrors(result, {
            FACTORY_RUN_FILE: put("bom.json", `\uFEFF${readFileSync(RUN_FILE, "utf8")}`),
        }), []);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
const cleanEnv = (env = {}) => {
    const res = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (!k.startsWith("FACTORY_") && v !== undefined)
            res[k] = v;
    }
    return { ...res, ...env };
};
const scratchRepo = () => {
    const dir = mkdtempSync(join(tmpdir(), "group-result-"));
    const main = join(dir, "main");
    spawnSync("git", ["init", "-q", main]);
    const c = spawnSync("git", [
        "-c",
        "user.email=a@example.test",
        "-c",
        "user.name=a",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "init",
    ], { cwd: main });
    assert.equal(c.status, 0);
    return {
        main,
        done: () => {
            rmSync(dir, { recursive: true, force: true });
        },
    };
};
const write = (cwd, args) => {
    const run = spawnSync(process.execPath, [WRITE, ...args], {
        cwd,
        env: cleanEnv({ FACTORY_RUN_ID: "rt-1", FACTORY_TICKET: "acme/app#12" }),
        encoding: "utf8",
    });
    return { status: run.status, stderr: run.stderr };
};
// A fixture as write-result input: the keys the script fills itself are dropped.
const input = (name) => {
    const omitKeys = new Set([
        "schema",
        "ticket",
        "run_id",
        "mode",
        "finished_at",
    ]);
    return Object.fromEntries(Object.entries(fixture(name)).filter(([k]) => !omitKeys.has(k)));
};
const resultFile = (main) => join(main, ".factory", "runs", "12", "result.json");
void test("group result: the writer writes an honest stop of the whole run after every member finished", () => {
    const r = scratchRepo();
    for (const name of [
        "valid-group-all-done-merge-gate.json",
        "valid-group-all-done-failed.json",
        "valid-group-finished-budget.json",
    ]) {
        writeFileSync(join(r.main, "in.json"), JSON.stringify(input(name)));
        const out = write(r.main, ["in.json"]);
        assert.equal(out.status, 0, `${name}: ${out.stderr}`);
        assert.equal(JSON.parse(readFileSync(resultFile(r.main), "utf8")).end_state, fixture(name).end_state);
    }
    r.done();
});
void test("group result: the writer writes schema 3 with tasks, schema 2 without", () => {
    const r = scratchRepo();
    writeFileSync(join(r.main, "group.json"), JSON.stringify(input("valid-group-all-outcomes.json")));
    assert.equal(write(r.main, ["group.json"]).status, 0);
    const group = JSON.parse(readFileSync(resultFile(r.main), "utf8"));
    assert.equal(group.schema, 3);
    assert.deepEqual(group.tasks, fixture("valid-group-all-outcomes.json").tasks);
    const keys = Object.keys(group);
    assert.ok(keys.indexOf("pr") < keys.indexOf("tasks") &&
        keys.indexOf("tasks") < keys.indexOf("decisions"));
    writeFileSync(join(r.main, "single.json"), JSON.stringify(input("valid-single.json")));
    assert.equal(write(r.main, ["single.json"]).status, 0);
    const single = JSON.parse(readFileSync(resultFile(r.main), "utf8"));
    assert.equal(single.schema, 2);
    assert.equal("tasks" in single, false);
    r.done();
});
void test("group result: the writer refuses tasks that break a rule and writes nothing", () => {
    const r = scratchRepo();
    writeFileSync(join(r.main, "bad.json"), JSON.stringify(input("invalid-link-mismatch.json")));
    const out = write(r.main, ["bad.json"]);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /pr_link must be "closes"/);
    assert.equal(existsSync(resultFile(r.main)), false);
    const takeover = input("valid-group-all-outcomes.json");
    takeover.tasks = takeover.tasks.map((t) => t.outcome === "parked" ? { ...t, reason_code: "takeover" } : t);
    writeFileSync(join(r.main, "takeover.json"), JSON.stringify(takeover));
    const refused = write(r.main, ["takeover.json"]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /tasks: reason_code takeover is written only by a runtime/);
    assert.equal(existsSync(resultFile(r.main)), false);
    r.done();
});
