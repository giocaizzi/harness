import { test } from "node:test";
import assert from "node:assert/strict";
import { windows, windowOf, dateChunks, percentile, duration, windowStats, mergeStats, flags, auditWorkflows, analyze, report, repoTable, collect, countFlakes, sampleWaits, MIN_RUNS, GROWTH, limited, GhError, parseIncluded, includeRunner, retrying, MAX_WAIT, fetchChunk, splitRange, fetchWorkflows, hasMergeQueue, errorLine, isPartial, retryAfterSeconds, } from "../scripts/ci-health.mjs";
const NOW = Date.parse("2026-10-30T12:00:00Z");
const iso = (d, t = "00:00:00") => `2026-10-${d}T${t}Z`;
let id = 0;
const run = (o = {}) => ({
    id: ++id,
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    head_sha: "a",
    workflow_id: 1,
    created_at: iso("05", "10:00:00"),
    run_started_at: iso("05", "10:01:00"),
    updated_at: iso("05", "10:03:00"),
    ...o,
});
const S = (runs, merged = 0, waits = [], flakes = 0) => windowStats(runs, merged, waits, flakes);
const MIN = 60000;
void test("windows split by UTC day, with a boundary", () => {
    const w = windows(30, NOW);
    assert.deepEqual(w, {
        prevFrom: "2026-09-01",
        prevTo: "2026-09-30",
        curFrom: "2026-10-01",
        curTo: "2026-10-30",
    });
    assert.equal(windowOf("2026-10-01", w), "cur");
    assert.equal(windowOf("2026-09-30", w), "prev");
    assert.equal(windowOf("2026-08-31", w), null);
    assert.equal(windowOf("2026-10-31", w), null);
});
void test("dateChunks split into 7-day parts", () => {
    const c = dateChunks("2026-09-01", "2026-10-30");
    assert.equal(c.length, 9);
    assert.deepEqual(c[0], ["2026-09-01", "2026-09-07"]);
    assert.deepEqual(c.at(-1), ["2026-10-27", "2026-10-30"]);
});
void test("runs per merged PR keeps PR and merge-group apart and excludes skipped", () => {
    const s = S([
        run(),
        run(),
        run({ event: "pull_request_target" }),
        run({ event: "merge_group" }),
        run({ conclusion: "skipped" }),
        run({ event: "merge_group", conclusion: "skipped" }),
        run({ event: "push" }),
    ], 2);
    assert.equal(s.prRunsPerPr, 1.5);
    assert.equal(s.mgRunsPerPr, 0.5);
    assert.equal(S([run()], 0).prRunsPerPr, null);
    const repoRecord = {
        key: "h/o/r",
        prev: { runs: [], mergedPrs: 0, waits: [], flakes: 0 },
        cur: { runs: [run()], mergedPrs: 0, waits: [], flakes: 0 },
        files: [],
        hasQueue: false,
    };
    const analysis = analyze([repoRecord]);
    assert.match(report(analysis, "30d"), /\| PR runs per merged PR \| - \| - \|/);
});
void test("run time and queue-to-green percentiles", () => {
    const runs = [1, 2, 3, 4, 10].map((m) => run({
        run_started_at: iso("05", "10:01:00"),
        created_at: iso("05", "10:00:00"),
        updated_at: new Date(Date.parse(iso("05", "10:01:00")) + m * MIN).toISOString(),
    }));
    const s = S([
        ...runs,
        run({ conclusion: "failure", updated_at: iso("05", "11:00:00") }),
    ]);
    assert.equal(s.runP50, 3 * MIN);
    assert.equal(s.runP90, 59 * MIN);
    assert.equal(s.greenP50, 4 * MIN);
    assert.equal(s.greenP90, 11 * MIN);
    assert.equal(percentile([], 0.5), null);
    assert.equal(percentile([5, 1, 3], 0.5), 3);
    assert.equal(percentile([1, 2], 0.9), 2);
});
void test("durations format", () => {
    assert.equal(duration(45000), "45s");
    assert.equal(duration(125000), "2m 5s");
    assert.equal(duration(3900000), "1h 5m");
    assert.equal(duration(null), "-");
});
void test("queue wait percentiles come from the sampled jobs", () => {
    const s = S([], 0, [10000, 20000, 30000, 40000]);
    assert.equal(s.waitP50, 20000);
    assert.equal(s.waitP90, 40000);
});
void test("cancelled, failure and re-run shares use completed non-skipped runs", () => {
    const s = S([
        run(),
        run({ conclusion: "cancelled" }),
        run({ conclusion: "cancelled" }),
        run({ conclusion: "failure" }),
        run({ conclusion: "timed_out" }),
        run({ run_attempt: 2 }),
        run({ conclusion: "skipped" }),
        run({ status: "in_progress", conclusion: null }),
    ]);
    assert.equal(s.completed, 6);
    assert.equal(s.cancelledShare, 2 / 6);
    assert.equal(s.failureShare, 2 / 6);
    assert.equal(s.rerunShare, 1 / 6);
});
void test("flake proxy divides the flakes by completed non-skipped runs", () => {
    const s = S([run(), run(), run(), run(), run({ conclusion: "skipped" })], 0, [], 1);
    assert.equal(s.flakeShare, 0.25);
    assert.equal(s.flakes, 1);
});
void test("flake proxy counts a re-run success whose previous attempt failed", async () => {
    const calls = [];
    const runner = (args) => {
        calls.push(args.find((a) => a.startsWith("repos/")));
        return Promise.resolve(JSON.stringify({
            conclusion: args.some((a) => a.endsWith("/attempts/2"))
                ? "failure"
                : "cancelled",
        }));
    };
    const runs = [
        run({ id: 1, run_attempt: 3, conclusion: "success" }),
        run({ id: 2, run_attempt: 2 }),
        run({ id: 3, run_attempt: 2, conclusion: "failure" }),
        run({ id: 4 }),
    ];
    assert.equal(await countFlakes(runner, "h", "acme/app", runs), 1);
    assert.deepEqual(calls, [
        "repos/acme/app/actions/runs/1/attempts/2",
        "repos/acme/app/actions/runs/2/attempts/1",
    ]);
});
void test("merge-group eject rate", () => {
    const s = S([
        run({ event: "merge_group" }),
        run({ event: "merge_group", conclusion: "failure" }),
        run({ event: "merge_group", conclusion: "cancelled" }),
        run({ event: "merge_group", conclusion: "timed_out" }),
        run({ event: "merge_group", conclusion: "skipped" }),
        run({ conclusion: "failure" }),
    ], 0);
    assert.equal(s.ejectRate, 0.75);
    assert.equal(S([run()]).ejectRate, null);
});
void test("skipped-run noise is skipped over all completed runs", () => {
    const s = S([
        run(),
        run(),
        run({ conclusion: "skipped" }),
        run({ status: "queued", conclusion: null }),
    ]);
    assert.equal(s.skipped, 1);
    assert.equal(s.skippedNoise, 1 / 3);
});
void test("limited runs at most N queries concurrently", async () => {
    let active = 0;
    let maxActive = 0;
    const runner = async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return "ok";
    };
    const lim = limited(runner, 3);
    await Promise.all(Array.from({ length: 10 }, () => lim(["x"])));
    assert.equal(maxActive, 3);
});
void test("aggregate sums raw tallies, not percentages", () => {
    const a = S([run(), run({ conclusion: "failure" })]);
    const b = S([
        run(),
        run(),
        run(),
        run(),
        run(),
        run(),
        run(),
        run({ conclusion: "failure" }),
    ]);
    const m = mergeStats([a, b]);
    assert.equal(m.failureShare, 2 / 10);
    assert.equal(m.completed, 10);
});
const stats = (n, minutes, rerun = 0) => S(Array.from({ length: n }, (_, i) => run({
    run_attempt: i < rerun ? 2 : 1,
    run_started_at: iso("05", "10:00:00"),
    updated_at: new Date(Date.parse(iso("05", "10:00:00")) + minutes * MIN).toISOString(),
})));
void test("criticalPathGrew needs the growth and the minimum runs", () => {
    assert.equal(GROWTH, 1.2);
    assert.equal(MIN_RUNS, 5);
    assert.equal(flags(stats(5, 10), stats(5, 12)).criticalPathGrew, true);
    assert.equal(flags(stats(5, 10), stats(5, 11.9)).criticalPathGrew, false);
    assert.equal(flags(stats(4, 10), stats(5, 20)).criticalPathGrew, false);
    assert.equal(flags(stats(5, 10), stats(4, 20)).criticalPathGrew, false);
});
void test("rerunGrew needs a higher share and the minimum runs", () => {
    assert.equal(flags(stats(5, 10, 1), stats(5, 10, 2)).rerunGrew, true);
    assert.equal(flags(stats(5, 10, 2), stats(5, 10, 2)).rerunGrew, false);
    assert.equal(flags(stats(5, 10, 0), stats(4, 10, 4)).rerunGrew, false);
    assert.equal(flags(stats(4, 10, 0), stats(5, 10, 4)).rerunGrew, false);
});
const wf = (text) => [
    { path: ".github/workflows/a.yml", text },
];
const SHA = "a".repeat(40);
void test("audit: concurrency at top level or in a job", () => {
    const top = auditWorkflows(wf("on: push\nconcurrency:\n  group: x\njobs:\n  a:\n    runs-on: x\n"), false);
    const job = auditWorkflows(wf("on: push\njobs:\n  a:\n    concurrency: g\n    runs-on: x\n"), false);
    const none = auditWorkflows(wf("on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: echo concurrency:\n      - uses: o/r@v1\n        with:\n          concurrency: x\n"), false);
    assert.deepEqual([top.concurrency, job.concurrency, none.concurrency], [1, 1, 0]);
});
void test("audit: cancel-in-progress counts for pull_request workflows only", () => {
    const pr = "on:\n  pull_request:\n    branches: [main]\nconcurrency:\n  group: x\n  cancel-in-progress: true\njobs: {}\n";
    assert.deepEqual([auditWorkflows(wf(pr)).prWorkflows, auditWorkflows(wf(pr)).prCancel], [1, 1]);
    const off = auditWorkflows(wf(pr.replace("true", "false")));
    assert.deepEqual([off.prWorkflows, off.prCancel], [1, 0]);
    const push = auditWorkflows(wf(pr.replace("pull_request:", "push:")));
    assert.deepEqual([push.prWorkflows, push.prCancel], [0, 0]);
    assert.equal(auditWorkflows(wf("on: [push, pull_request]\njobs: {}\n")).prWorkflows, 1);
});
void test("audit: timeout-minutes per job, reusable calls excluded", () => {
    const a = auditWorkflows(wf("on: push\njobs:\n  a:\n    runs-on: x\n    timeout-minutes: 5\n    steps:\n      - run: x\n        timeout-minutes: 1\n  b:\n    runs-on: x\n    steps:\n      - run: x\n        timeout-minutes: 1\n  c:\n    uses: o/r/.github/workflows/w.yml@main\n    timeout-minutes: 9\n"), false);
    assert.deepEqual([a.jobs, a.reusable, a.timeouts], [3, 1, 1]);
});
void test("audit: queue without merge_group trigger", () => {
    const none = "on:\n  pull_request:\njobs: {}\n";
    const mg = "on:\n  merge_group:\njobs: {}\n";
    assert.equal(auditWorkflows(wf(none), true).queueWithoutMergeGroup, true);
    assert.equal(auditWorkflows(wf(none), false).queueWithoutMergeGroup, false);
    assert.equal(auditWorkflows(wf(mg), true).queueWithoutMergeGroup, false);
    assert.equal(auditWorkflows([...wf(none), ...wf(mg)], true).queueWithoutMergeGroup, false);
});
void test("audit: path filters need an aggregate check", () => {
    const filtered = "on:\n  pull_request:\n    paths:\n      - src/**\njobs:\n  a:\n    runs-on: x\n";
    assert.equal(auditWorkflows(wf(filtered)).pathFilterNoAggregate, true);
    assert.equal(auditWorkflows(wf("on:\n  push:\n    paths-ignore: [docs/**]\njobs:\n  a:\n    runs-on: x\n")).pathFilterNoAggregate, true);
    assert.equal(auditWorkflows(wf("on:\n  pull_request:\n    branches: [main]\njobs:\n  a:\n    runs-on: x\n")).pathFilterNoAggregate, false);
    const gate = "on: push\njobs:\n  gate:\n    needs: [a]\n    if: always()\n    runs-on: x\n";
    assert.equal(auditWorkflows([...wf(filtered), { path: "b.yml", text: gate }])
        .pathFilterNoAggregate, false);
    const noIf = "on: push\njobs:\n  gate:\n    needs: [a]\n    runs-on: x\n";
    assert.equal(auditWorkflows([...wf(filtered), { path: "b.yml", text: noIf }])
        .pathFilterNoAggregate, true);
});
void test("audit: cache by action or input", () => {
    const act = auditWorkflows(wf("on: push\njobs:\n  a:\n    steps:\n      - uses: actions/cache@v4\n"));
    const inp = auditWorkflows(wf("on: push\njobs:\n  a:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          cache: npm\n"));
    const none = auditWorkflows(wf("on: push\njobs:\n  a:\n    steps:\n      - run: echo\n"));
    assert.deepEqual([act.caches, inp.caches, none.caches], [1, 1, 0]);
});
void test("audit: SHA pinning skips local and docker refs", () => {
    const text = `on: push\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@${SHA}\n      - uses: actions/setup-node@v4 # note\n      - uses: ./local@v1\n      - uses: docker://alpine@v1\n      - uses: o/r/path@${SHA.slice(1)}\n      - uses: o/r2@${SHA}\n`;
    const a = auditWorkflows(wf(text));
    assert.deepEqual([a.refs, a.pinned], [4, 2]);
});
void test("audit: top-level permissions only", () => {
    const top = auditWorkflows(wf("permissions:\n  contents: read\non: push\njobs: {}\n"));
    const job = auditWorkflows(wf("on: push\njobs:\n  a:\n    permissions:\n      contents: read\n"));
    assert.deepEqual([top.permissions, job.permissions], [1, 0]);
});
const hostsJson = JSON.stringify({
    hosts: {
        "github.com": [{ state: "success", active: true }],
        "bad.example": [{ state: "error", active: true }],
    },
});
const repoNode = {
    repository: { nameWithOwner: "acme/app", defaultBranchRef: { name: "main" } },
};
const b64 = (s) => Buffer.from(s).toString("base64");
const field = (args, k) => {
    const item = args.find((a) => a.startsWith(`${k}=`));
    return item ? item.slice(k.length + 1) : "";
};
function fakeRunner(over = {}) {
    const calls = [];
    const runner = (args) => {
        calls.push(args);
        if (args[0] === "auth")
            return Promise.resolve(hostsJson);
        if (args[1] === "graphql") {
            if (field(args, "query").includes("issueCount")) {
                return Promise.resolve(JSON.stringify({
                    data: {
                        search: {
                            issueCount: field(args, "q").includes("2026-10-01..") ? 4 : 2,
                        },
                    },
                }));
            }
            const first = field(args, "q").endsWith("2026-09-01..2026-09-07") &&
                !field(args, "cursor");
            const second = field(args, "cursor") === "c1";
            return Promise.resolve(JSON.stringify({
                data: {
                    search: {
                        pageInfo: { hasNextPage: first, endCursor: "c1" },
                        nodes: first || second ? [repoNode, repoNode] : [],
                    },
                },
            }));
        }
        const path = args[args.indexOf("GET") + 1] ?? "";
        const override = over[path];
        if (override)
            return override(args);
        if (path === "repos/acme/app/actions/runs") {
            const [from] = field(args, "created").split("..");
            const page = Number(field(args, "page"));
            if (from === "2026-10-06") {
                return Promise.resolve(JSON.stringify({
                    workflow_runs: Array.from({ length: page === 1 ? 100 : 2 }, (_, i) => run({ id: 1000 + (page === 1 ? i : 99 + i) })),
                }));
            }
            if (from === "2026-09-29") {
                return Promise.resolve(JSON.stringify({
                    workflow_runs: [
                        run({ id: 5000, created_at: "2026-09-30T10:00:00Z" }),
                        run({ id: 5001, created_at: "2026-09-29T23:00:00Z" }),
                        run({ id: 5002, created_at: "2026-09-30T10:00:00Z" }),
                    ],
                }));
            }
            if (from === "2026-10-27") {
                return Promise.resolve(JSON.stringify({
                    workflow_runs: [
                        run({ id: 5000, created_at: "2026-09-30T10:00:00Z" }),
                    ],
                }));
            }
            return Promise.resolve(JSON.stringify({ workflow_runs: [] }));
        }
        if (path.endsWith("/jobs")) {
            return Promise.resolve(JSON.stringify({
                jobs: [
                    {
                        created_at: iso("05", "10:00:00"),
                        started_at: iso("05", "10:00:20"),
                        conclusion: "success",
                    },
                    {
                        created_at: iso("05", "10:00:00"),
                        started_at: iso("05", "10:09:00"),
                        conclusion: "skipped",
                    },
                ],
            }));
        }
        if (path === "repos/acme/app/contents/.github/workflows") {
            return Promise.resolve(JSON.stringify([
                { type: "file", name: "a.yml", path: ".github/workflows/a.yml" },
                {
                    type: "file",
                    name: "README.md",
                    path: ".github/workflows/README.md",
                },
            ]));
        }
        if (path === "repos/acme/app/contents/.github/workflows/a.yml") {
            return Promise.resolve(JSON.stringify({ content: b64("on: merge_group\njobs: {}\n") }));
        }
        if (path === "repos/acme/app/rules/branches/main") {
            return Promise.resolve(JSON.stringify([{ type: "merge_queue" }]));
        }
        return Promise.reject(new GhError(404));
    };
    return { runner, calls };
}
void test("collect pages, chunks and dedupes repos, runs and windows", async () => {
    const { runner, calls } = fakeRunner();
    const repos = (await collect(runner, 30, NOW)) ?? [];
    assert.equal(repos.length, 1);
    const r = repos[0];
    assert.ok(r);
    assert.equal(r.key, "github.com/acme/app");
    assert.equal(calls.filter((c) => c[1] === "graphql").length, 9 + 1 + 2);
    assert.ok(calls
        .filter((c) => c[0] === "api")
        .every((c) => c.includes("github.com") && c.includes("--hostname")));
    assert.equal(r.cur.runs.length, 101);
    assert.deepEqual(r.prev.runs.map((x) => x.id), [5000, 5001, 5002]);
    assert.deepEqual([r.prev.mergedPrs, r.cur.mergedPrs], [2, 4]);
    const firstCurRun = r.cur.runs[0];
    assert.deepEqual(firstCurRun ? Object.keys(firstCurRun).sort() : [], [
        "conclusion",
        "created_at",
        "event",
        "head_sha",
        "id",
        "run_attempt",
        "run_started_at",
        "status",
        "updated_at",
        "workflow_id",
    ]);
    assert.equal(r.files.length, 1);
    assert.equal(r.hasQueue, true);
});
void test("queue wait samples at most 30 recent completed PR runs and skips skipped jobs", async () => {
    const { runner, calls } = fakeRunner();
    const repos = (await collect(runner, 30, NOW)) ?? [];
    const firstRepo = repos[0];
    assert.ok(firstRepo);
    assert.equal(firstRepo.cur.waits.length, 30);
    assert.ok(firstRepo.cur.waits.every((w) => w === 20000));
    assert.equal(firstRepo.prev.waits.length, 3);
    assert.equal(calls.filter((c) => c.some((a) => a.endsWith("/jobs"))).length, 33);
    const runs = [
        run({ id: 1, event: "push" }),
        run({ id: 2, status: "in_progress" }),
        run({ id: 3, created_at: iso("06", "00:00:00") }),
        run({ id: 4, event: "merge_group", created_at: iso("07", "00:00:00") }),
    ];
    const seen = [];
    const w = await sampleWaits((a) => {
        seen.push(a[5] ?? "");
        return Promise.resolve(JSON.stringify({
            jobs: [
                {
                    created_at: iso("05"),
                    started_at: iso("05", "00:00:05"),
                    conclusion: "success",
                },
            ],
        }));
    }, "h", "acme/app", runs);
    assert.deepEqual(seen, [
        "repos/acme/app/actions/runs/4/jobs",
        "repos/acme/app/actions/runs/3/jobs",
    ]);
    assert.deepEqual(w, [5000, 5000]);
});
void test("a failed query continues and names no repo", async () => {
    const { runner } = fakeRunner({
        "repos/acme/app/actions/runs": () => Promise.reject(new Error("boom acme/app")),
    });
    const err = console.error;
    const seen = [];
    console.error = (m) => {
        seen.push(typeof m === "string" ? m : String(m));
    };
    try {
        const repos = await collect(runner, 30, NOW, 6, { tries: 1 });
        assert.ok(repos);
        const firstRepo = repos[0];
        assert.ok(firstRepo);
        assert.equal(firstRepo.cur.runs.length, 0);
        assert.equal(firstRepo.files.length, 1);
        assert.equal(firstRepo.failures?.runs, 9);
        assert.ok(isPartial(firstRepo));
        const agg = analyze(repos);
        assert.deepEqual([agg.repos, agg.partial, agg.failedQueries, agg.cur.completed], [0, 1, 9, 0]);
        assert.match(report(agg, "30d"), /\| Repos left out as partial[^\n]*\| - \| 1 \|\n\| Queries failed after retries \| - \| 9 \(runs 9\) \|/);
        assert.match(repoTable(agg), /github\.com\/acme\/app \| unknown \| unknown[^\n]*partial: 9 failed, 0 truncated/);
    }
    finally {
        console.error = err;
    }
    assert.ok(seen.includes("CI health: a query failed; continuing"));
    assert.ok(seen.includes("CI health: 1/1 repos measured"));
    assert.ok(seen.every((m) => !m.includes("acme")));
});
void test("report has no repo names; repoTable does", () => {
    const rec = {
        key: "github.com/acme/app",
        prev: {
            runs: [run({ run_attempt: 2 })],
            mergedPrs: 1,
            waits: [],
            flakes: 0,
        },
        cur: {
            runs: [run({ event: "merge_group" }), run()],
            mergedPrs: 2,
            waits: [30000],
            flakes: 1,
        },
        files: wf("on: pull_request\njobs:\n  a:\n    timeout-minutes: 3\n"),
        hasQueue: true,
    };
    const agg = analyze([rec]);
    const out = report(agg, "30d");
    assert.ok(!out.includes("acme"));
    assert.match(out, /## CI health \(last 30d vs the 30d before, repos you merged a PR into, every host gh can reach\)/);
    assert.match(out, /\| Merged PRs \(all authors, in the measured repos\) \| 1 \| 2 \|/);
    assert.match(out, /\| Repos left out as partial[^\n]*\| - \| 0 \|/);
    assert.match(out, /repos you merged a PR into, every host gh can reach/);
    assert.match(out, /\| PR runs per merged PR \| 1\.0 \| 0\.5 \|/);
    assert.match(out, /\| Re-run share \| 100% \(1\) \| 0% \(0\) \|/);
    assert.match(out, /\| Queue wait p50 \/ p90 \(sampled jobs\) \| - \/ - \| 30s \/ 30s \|/);
    assert.match(out, /\| Jobs with timeout-minutes \| 100% \(1\/1\) \|/);
    assert.match(out, /\| Repos with a merge queue and no merge_group trigger \| 1 \|/);
    assert.match(out, /How to read each figure: \.agents\/skills\/agent-review\/references\/reading\.md \(CI health\)\./);
    assert.match(repoTable(agg), /Local detail: never paste[\s\S]*github\.com\/acme\/app \| 2 \| 2 \|[^\n]*queue without merge_group/);
});
const quiet = async (fn) => {
    const err = console.error;
    console.error = () => undefined;
    try {
        return await fn();
    }
    finally {
        console.error = err;
    }
};
void test("a failed merged-PR count is null and counted, and the repo is partial", async () => {
    const { runner } = fakeRunner();
    const failing = (a) => {
        if (a[1] === "graphql" && a.some((x) => x.includes("issueCount"))) {
            return Promise.reject(new GhError(502));
        }
        return runner(a);
    };
    const repos = (await quiet(() => collect(failing, 30, NOW, 6, { tries: 1 }))) ?? [];
    const r = repos[0];
    assert.ok(r);
    assert.deepEqual([r.prev.mergedPrs, r.cur.mergedPrs, r.failures?.merged], [null, null, 2]);
    const agg = analyze([r]);
    assert.deepEqual([agg.repos, agg.partial, agg.cur.mergedPrs], [0, 1, 0]);
});
void test("a partial repo is left out of the figures and the flags", () => {
    const runs = Array.from({ length: 6 }, () => run({ run_attempt: 2 }));
    const ok = {
        key: "h/acme/ok",
        prev: {
            runs: runs.map((x) => ({ ...x, run_attempt: 1 })),
            mergedPrs: 1,
            waits: [],
            flakes: 0,
        },
        cur: { runs, mergedPrs: 1, waits: [], flakes: 0 },
        files: [],
        hasQueue: false,
        failures: {},
        truncated: 0,
    };
    const bad = { ...ok, key: "h/acme/bad", failures: { jobs: 1 } };
    const cut = { ...ok, key: "h/acme/cut", truncated: 1 };
    const agg = analyze([ok, bad, cut]);
    assert.deepEqual([
        agg.repos,
        agg.partial,
        agg.rerunGrew,
        agg.cur.completed,
        agg.truncated,
        agg.failedQueries,
    ], [1, 2, 1, 6, 1, 1]);
    assert.equal(agg.perRepo["h/acme/bad"]?.rerunGrew, false);
});
void test("workflows: a 404 is no directory, another failure is counted, a file over 1 MB is skipped and counted", async () => {
    const t1 = {};
    assert.deepEqual(await fetchWorkflows(() => Promise.reject(new GhError(404)), "h", "acme/app", t1), { files: [], tooLarge: 0 });
    assert.equal(t1.workflows, undefined);
    const t2 = {};
    await quiet(() => fetchWorkflows(() => Promise.reject(new GhError(500)), "h", "acme/app", t2));
    assert.equal(t2.workflows, 1);
    const big = (a) => {
        const lastArg = a.at(-1) ?? "";
        if (lastArg.endsWith("workflows")) {
            return Promise.resolve(JSON.stringify([
                { type: "file", name: "a.yml", path: ".github/workflows/a.yml" },
                { type: "file", name: "b.yml", path: ".github/workflows/b.yml" },
            ]));
        }
        if (lastArg.endsWith("a.yml")) {
            return Promise.resolve(JSON.stringify({ content: "", encoding: "none", size: 2000000 }));
        }
        return Promise.resolve(JSON.stringify({ content: b64("on: push\n") }));
    };
    const w = await fetchWorkflows(big, "h", "acme/app", {});
    assert.deepEqual([w.files.length, w.tooLarge], [1, 1]);
    const agg = analyze([
        {
            key: "h/acme/app",
            prev: { runs: [], mergedPrs: 0, waits: [], flakes: 0 },
            cur: { runs: [], mergedPrs: 0, waits: [], flakes: 0 },
            files: w.files,
            tooLarge: w.tooLarge,
            hasQueue: false,
            failures: {},
            truncated: 0,
        },
    ]);
    assert.match(report(agg, "30d"), /\| Workflow files skipped \(over 1 MB, the contents API limit\) \| 1 \|/);
});
void test("merge queue: a 404 is no rules, another failure is counted", async () => {
    const t = {};
    assert.equal(await hasMergeQueue(() => Promise.reject(new GhError(404)), "h", "acme/app", "main", t), false);
    assert.equal(t.queue, undefined);
    assert.equal(await hasMergeQueue(() => Promise.reject(new GhError(403, {}, "Upgrade to GitHub Pro or make this repository public to enable this feature.")), "h", "acme/app", "main", t), false);
    assert.equal(t.queue, undefined);
    await quiet(() => hasMergeQueue(() => Promise.reject(new GhError(503)), "h", "acme/app", "main", t));
    await quiet(() => hasMergeQueue(() => Promise.reject(new GhError(403, {}, "Resource not accessible")), "h", "acme/app", "main", t));
    assert.equal(t.queue, 2);
});
void test("a run range over the 1000 cap is refetched by day, 6 hours and hour, and an hour still over it is truncated", async () => {
    const seen = [];
    const runner = (a) => {
        const createdItem = a.find((x) => x.startsWith("created="));
        const created = createdItem ? createdItem.slice(8) : "";
        const pageItem = a.find((x) => x.startsWith("page="));
        const page = pageItem ? Number(pageItem.slice(5)) : 1;
        seen.push(`${created}#${String(page)}`);
        if (seen.length > 400)
            throw new Error("paged past the 1000-run cap");
        const [from, to] = created.split("..");
        const over = from !== to && (from ?? "").length === 10
            ? true
            : from === "2026-10-02" ||
                created === "2026-10-02T00:00:00Z..2026-10-02T05:59:59Z" ||
                from === "2026-10-02T03:00:00Z";
        if (over) {
            return Promise.resolve(JSON.stringify({
                total_count: 1500,
                workflow_runs: Array.from({ length: 100 }, () => run()),
            }));
        }
        return Promise.resolve(JSON.stringify({
            total_count: 1,
            workflow_runs: page === 1 ? [run()] : [],
        }));
    };
    const tally = {};
    const runs = await fetchChunk(runner, "h", "acme/app", "2026-10-01", "2026-10-03", tally);
    assert.equal(tally.truncated, 1);
    assert.equal(runs.length, 2 + 3 + 5 + 1000);
    assert.equal(seen.filter((x) => x.startsWith("2026-10-01..2026-10-03")).length, 10);
    assert.ok(seen.includes("2026-10-02T06:00:00Z..2026-10-02T11:59:59Z#1"));
    assert.ok(seen.includes("2026-10-02T03:00:00Z..2026-10-02T03:59:59Z#1"));
});
void test("splitRange ladders a week to days, a day to 6 hours, 6 hours to hours, and stops at an hour", () => {
    assert.deepEqual(splitRange("2026-10-01", "2026-10-02"), [
        ["2026-10-01", "2026-10-01"],
        ["2026-10-02", "2026-10-02"],
    ]);
    const splitDay = splitRange("2026-10-02", "2026-10-02");
    assert.ok(splitDay);
    assert.deepEqual(splitDay[1], [
        "2026-10-02T06:00:00Z",
        "2026-10-02T11:59:59Z",
    ]);
    assert.equal(splitDay.length, 4);
    assert.equal(splitRange("2026-10-02T00:00:00Z", "2026-10-02T05:59:59Z")?.length, 6);
    assert.equal(splitRange("2026-10-02T03:00:00Z", "2026-10-02T03:59:59Z"), null);
});
void test("greenTimes drops negative durations from clock skew", () => {
    const s = S([
        run({
            created_at: iso("05", "10:05:00"),
            updated_at: iso("05", "10:03:00"),
        }),
        run(),
    ]);
    assert.deepEqual(s.greenTimes, [3 * MIN]);
});
void test("includeRunner parses --include output and turns a failure into a GhError without the command line", async () => {
    const ok = await includeRunner(["api", "x"], (a) => {
        assert.equal(a[1], "--include");
        return Promise.resolve('HTTP/2.0 200 OK\r\nX-Ratelimit-Remaining: 9\r\n\r\n{"a":1}');
    });
    assert.equal(ok, '{"a":1}');
    assert.equal(await includeRunner(["auth", "status"], (a) => Promise.resolve(a.join(" "))), "auth status");
    const e = (await includeRunner(["api", "repos/acme/app"], () => {
        return Promise.reject(Object.assign(new Error("Command failed: gh api repos/acme/app"), {
            stdout: "HTTP/2.0 429 Too Many\nRetry-After: 7\nX-RateLimit-Remaining: 0\nX-RateLimit-Reset: 100\n\n{}",
        }));
    }).catch((x) => x));
    assert.ok(e instanceof GhError);
    assert.deepEqual([e.status, e.retryAfter, e.remaining, e.reset], [429, 7, 0, 100]);
    const d = (await includeRunner(["api", "x"], () => {
        return Promise.reject(Object.assign(new Error("x"), {
            stdout: 'HTTP/2.0 403 Forbidden\n\n{"message":"Upgrade to GitHub Pro"}',
        }));
    }).catch((x) => x));
    assert.deepEqual([d.status, d.detail, d.message], [403, "Upgrade to GitHub Pro", "gh call failed (HTTP 403)"]);
    assert.ok(!e.message.includes("acme"));
    assert.deepEqual(parseIncluded("plain"), {
        status: null,
        headers: {},
        body: "plain",
    });
});
void test("retrying honours Retry-After, backs off on 5xx, stops at the try limit and skips plain failures", async () => {
    const waits = [];
    const wait = (s) => {
        waits.push(s);
        return Promise.resolve();
    };
    let n = 0;
    const flaky = () => {
        n++;
        if (n === 1)
            throw new GhError(429, { "retry-after": "7" });
        if (n === 2)
            throw new GhError(502);
        if (n === 3)
            throw new GhError(403, {
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": "1030",
            });
        return Promise.resolve("ok");
    };
    assert.equal(await retrying(flaky, { wait, now: () => 1000000 })(["api"]), "ok");
    assert.deepEqual(waits, [7, 4, 31]);
    let m = 0;
    await assert.rejects(retrying(() => {
        if (++m > 10)
            return Promise.resolve("retried past the limit");
        throw new GhError(500);
    }, { tries: 3, wait })(["api"]));
    assert.equal(m, 3);
    let p = 0;
    await assert.rejects(retrying(() => {
        p++;
        throw new GhError(403);
    }, { wait })(["api"]));
    await assert.rejects(retrying(() => {
        p++;
        throw new GhError(404);
    }, { wait })(["api"]));
    assert.equal(p, 2);
    let q = 0;
    await assert.rejects(retrying(() => {
        q++;
        throw new GhError(429, { "retry-after": String(MAX_WAIT + 1) });
    }, { wait })(["api"]));
    assert.equal(q, 1);
});
void test("the top-level error line withholds a gh command line", () => {
    assert.equal(errorLine(new Error('bad --range "x" (use Nd or Nw)')), 'bad --range "x" (use Nd or Nw)');
    assert.ok(!errorLine(new Error("Command failed: gh api repos/acme/app/actions/runs")).includes("acme"));
});
void test("collect retries a rate-limited call instead of counting it failed", async () => {
    const { runner } = fakeRunner();
    let hit = 0;
    const once = (a) => {
        if (a.includes("repos/acme/app/actions/runs") && !hit++) {
            return Promise.reject(new GhError(429, { "retry-after": "1" }));
        }
        return runner(a);
    };
    const waits = [];
    const repos = await quiet(() => collect(once, 30, NOW, 6, {
        wait: (s) => {
            waits.push(s);
            return Promise.resolve();
        },
    }));
    const r = repos?.[0];
    assert.deepEqual([r?.failures?.runs, waits], [undefined, [1]]);
});
void test("a failed repo-discovery query is counted in the report", async () => {
    const { runner } = fakeRunner();
    const failing = (a) => {
        if (a[1] === "graphql" &&
            field(a, "q").startsWith("author:@me") &&
            field(a, "q").endsWith("2026-10-27..2026-10-30")) {
            return Promise.reject(new GhError(500));
        }
        return runner(a);
    };
    const repos = await quiet(() => collect(failing, 30, NOW, 6, { tries: 1 }));
    assert.ok(repos);
    const agg = analyze(repos);
    assert.deepEqual([repos.discoveryFailed, agg.failedQueries, agg.discoveryFailed], [1, 1, 1]);
    assert.match(report(agg, "30d"), /\| Queries failed after retries \| - \| 1 \(discovery 1\) \|/);
});
void test("Retry-After takes seconds or an HTTP date; anything else falls back to backoff", async () => {
    const now = Date.parse("2026-10-30T12:00:00Z");
    assert.equal(retryAfterSeconds("7", now), 7);
    assert.equal(retryAfterSeconds("Fri, 30 Oct 2026 12:00:09 GMT", now), 9);
    assert.equal(retryAfterSeconds("Fri, 30 Oct 2026 11:00:00 GMT", now), 0);
    assert.equal(retryAfterSeconds("soon", now), null);
    assert.equal(retryAfterSeconds(undefined, now), null);
    const e = new GhError(429, { "retry-after": "soon" });
    e.retryAfter = NaN;
    const waits = [];
    let n = 0;
    const r = retrying(() => {
        if (!n++)
            throw e;
        return Promise.resolve("ok");
    }, {
        wait: (s) => {
            waits.push(s);
            return Promise.resolve();
        },
    });
    assert.equal(await r(["api"]), "ok");
    assert.deepEqual(waits, [2]);
});
