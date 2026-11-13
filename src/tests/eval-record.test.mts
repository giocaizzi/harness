import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exposeTrace,
  grantedTools,
  isExactModel,
  removeTemp,
  resolveDirty,
  parseArgs,
  record,
  type Aggregate,
  type ScoreRow,
} from "../scripts/eval-record.mjs";

const quiet = (): void => undefined;

/** A git repo with plugins/acme (one case) and a results dir per given startedAt. */
function fixture(
  runs: { id: string; startedAt: string; trace?: boolean }[],
  plugin = "acme",
) {
  const root = mkdtempSync(join(tmpdir(), "eval-record-"));
  const git = (...args: string[]): string =>
    execFileSync(
      "git",
      ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        },
      },
    ).trim();
  git("init", "-q");
  const pluginDir = join(root, "plugins", "acme");
  mkdirSync(join(pluginDir, "evals", "app-trigger"), { recursive: true });
  writeFileSync(
    join(pluginDir, "evals", "app-trigger", "case.yaml"),
    "name: app-trigger\ntags: [trigger, smoke]\n",
  );
  git("add", ".");
  git("commit", "-qm", "init");
  const sha = git("rev-parse", "HEAD");
  const temps: string[] = [];
  for (const r of runs) {
    const dir = join(pluginDir, "evals", "results", r.id);
    mkdirSync(dir, { recursive: true });
    // Where `claude plugin eval --keep-temp` leaves it: <tmp>/e-XXXXXX/out/trace.jsonl.
    const temp = mkdtempSync(join(tmpdir(), "e-"));
    temps.push(temp);
    mkdirSync(join(temp, "out"));
    const trace = join(temp, "out", "trace.jsonl");
    if (r.trace)
      writeFileSync(
        trace,
        `{"type":"system","subtype":"init","model":"claude-test-1"}\n{"type":"assistant"}\n`,
      );
    const arm = (passed: boolean) => ({
      passed,
      score: passed ? 1 : 0,
      turns: 4,
      durationSeconds: 20,
      error: passed ? null : "boom",
      costUsd: 0.1,
      judgeCostUsd: 0.01,
      tracePath: trace,
    });
    const agg: Aggregate = {
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
  const read = (): ScoreRow[] =>
    readFileSync(join(pluginDir, "evals", "scores.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as ScoreRow);
  return { pluginDir, sha, read, git, temps };
}

void test("parseArgs", () => {
  assert.deepEqual(
    parseArgs([
      "plugins/a",
      "r1",
      "--commit",
      "abc",
      "--model",
      "m",
      "--since",
      "2026",
    ]),
    {
      pluginDir: "plugins/a",
      dirs: ["r1"],
      commit: "abc",
      model: "m",
      since: "2026",
      dirty: null,
      cleanTemp: false,
      showTraces: false,
      allow: null,
      printAllow: null,
      sweepTemp: false,
    },
  );
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
    cleanTemp: false,
    showTraces: false,
    allow: null,
    printAllow: null,
    sweepTemp: false,
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
    cleanTemp: false,
    showTraces: false,
    allow: null,
    printAllow: null,
    sweepTemp: false,
  };
  assert.throws(() => record(base, quiet), /pass --model/);
  assert.equal(record({ ...base, model: "claude-test-2" }, quiet), 1);
  const [row] = f.read();
  assert.equal(row?.run, "new");
  assert.equal(row.model, "claude-test-2");
  assert.equal(row.commit, f.sha);
});

void test("refuses results of another plugin", () => {
  const f = fixture(
    [{ id: "r", startedAt: "2026-01-01T00:00:00.000Z", trace: true }],
    "other",
  );
  assert.throws(
    () =>
      record(
        {
          pluginDir: f.pluginDir,
          dirs: [],
          commit: null,
          model: null,
          since: null,
          dirty: null,
          cleanTemp: false,
          showTraces: false,
          allow: null,
          printAllow: null,
          sweepTemp: false,
        },
        quiet,
      ),
    /for other, not acme/,
  );
});

void test("dirty: auto reads tracked plugin changes, except results and the scoreboard; unknown leaves it out", () => {
  const f = fixture([
    { id: "r", startedAt: "2026-01-01T00:00:00.000Z", trace: true },
  ]);
  assert.equal(resolveDirty(f.pluginDir, null), undefined);
  assert.equal(resolveDirty(f.pluginDir, "true"), true);
  assert.throws(
    () => resolveDirty(f.pluginDir, "maybe"),
    /auto, true or false/,
  );
  assert.equal(resolveDirty(f.pluginDir, "auto"), false);
  const opts = {
    pluginDir: f.pluginDir,
    dirs: [],
    commit: null,
    model: null,
    since: null,
    dirty: null,
    cleanTemp: false,
    showTraces: false,
    allow: null,
    printAllow: null,
    sweepTemp: false,
  };
  record(opts, quiet);
  assert.equal("dirty" in (f.read()[0] ?? {}), false);
  f.git("add", ".");
  f.git("commit", "-qm", "scores");
  appendFileSync(join(f.pluginDir, "evals", "scores.jsonl"), "{}\n");
  assert.equal(
    resolveDirty(f.pluginDir, "auto"),
    false,
    "scores.jsonl and results do not count",
  );
  writeFileSync(
    join(f.pluginDir, "evals", "app-trigger", "case.yaml"),
    "name: app-trigger\ntags: [trigger]\n",
  );
  assert.equal(resolveDirty(f.pluginDir, "auto"), true);
});

void test("since compares instants: a run in the same second as since is recorded", () => {
  const f = fixture([
    { id: "r", startedAt: "2026-01-01T00:00:54.542Z", trace: true },
  ]);
  const opts = {
    pluginDir: f.pluginDir,
    dirs: [],
    commit: null,
    model: null,
    since: "2026-01-01T00:00:54Z",
    dirty: null,
    cleanTemp: false,
    showTraces: false,
    allow: null,
    printAllow: null,
    sweepTemp: false,
  };
  assert.equal(record(opts, quiet), 1);
});

void test("never records an alias: an alias --model without a trace fails", () => {
  assert.equal(isExactModel("claude-opus-5-5"), true);
  assert.equal(isExactModel("claude-3-5-sonnet-20241022"), true);
  for (const alias of [
    "sonnet",
    "opus",
    "opus[1m]",
    "claude-sonnet",
    "default",
  ])
    assert.equal(isExactModel(alias), false, alias);
  const f = fixture([{ id: "r", startedAt: "2026-01-01T00:00:00.000Z" }]);
  const opts = {
    pluginDir: f.pluginDir,
    dirs: [],
    commit: null,
    model: "sonnet",
    since: null,
    dirty: null,
    cleanTemp: false,
    showTraces: false,
    allow: null,
    printAllow: null,
    sweepTemp: false,
  };
  assert.throws(() => record(opts, quiet), /alias, not an exact model id/);
});

void test("--clean-temp removes the kept e-* temp dirs after reading the model, even on failure", () => {
  const f = fixture([
    { id: "a-ok", startedAt: "2026-01-01T00:00:00.000Z", trace: true },
    { id: "b-bad", startedAt: "2026-01-02T00:00:00.000Z" },
  ]);
  const opts = {
    pluginDir: f.pluginDir,
    dirs: [],
    commit: null,
    model: null,
    since: null,
    dirty: null,
    cleanTemp: true,
    showTraces: false,
    allow: null,
    printAllow: null,
    sweepTemp: false,
  };
  assert.throws(() => record(opts, quiet), /pass --model/);
  assert.equal(f.read()[0]?.model, "claude-test-1");
  for (const t of f.temps) assert.equal(existsSync(t), false, t);
});

void test("removeTemp deletes a sealed kept dir: read-only parent, mode-000 subdirs", () => {
  const dir = mkdtempSync(join(tmpdir(), "e-"));
  mkdirSync(join(dir, "out"));
  writeFileSync(join(dir, "out", "trace.jsonl"), "{}\n");
  mkdirSync(join(dir, "sealed", "home", "deep"), { recursive: true });
  writeFileSync(join(dir, "sealed", "home", "deep", "f"), "x");
  chmodSync(join(dir, "sealed", "home", "deep"), 0o000);
  chmodSync(join(dir, "sealed", "home"), 0o000);
  chmodSync(join(dir, "sealed"), 0o000);
  chmodSync(dir, 0o500);
  removeTemp(dir);
  assert.equal(existsSync(dir), false);
  removeTemp(dir);
});

void test("allow: recorded sorted when given (empty means none granted), left out otherwise", () => {
  const f = fixture([
    { id: "r", startedAt: "2026-01-01T00:00:00.000Z", trace: true },
  ]);
  const base = {
    pluginDir: f.pluginDir,
    dirs: [],
    commit: null,
    model: null,
    since: null,
    dirty: null,
    cleanTemp: false,
    showTraces: false,
    allow: "Write  Edit",
    printAllow: null,
    sweepTemp: false,
  };
  record(base, quiet);
  assert.deepEqual(f.read()[0]?.allow, ["Edit", "Write"]);
  assert.deepEqual(parseArgs(["p", "--allow", ""]).allow, "");
  assert.deepEqual(
    parseArgs(["p", "--print-allow", "trigger"]).printAllow,
    "trigger",
  );
  assert.equal(parseArgs(["--sweep-temp"]).sweepTemp, true);
});

void test("grantedTools: union of the tag's declared tools minus the read-only ones, Bash only if declared", () => {
  const root = mkdtempSync(join(tmpdir(), "eval-allow-"));
  const add = (name: string, tags: string, tools: string): void => {
    mkdirSync(join(root, "evals", name), { recursive: true });
    writeFileSync(
      join(root, "evals", name, "case.yaml"),
      `name: ${name}\ntags: ${tags}\nexecution:\n  prompt: x\n  allowed_tools: ${tools}\n`,
    );
  };
  add("a", "[trigger]", "[Read, Glob, Grep, Skill]");
  assert.deepEqual(grantedTools(root, "trigger"), []);
  add("b", "[trigger]", "[Read, Edit, Write, Skill]");
  add("c", "[routing]", "[Bash, Agent]");
  assert.deepEqual(grantedTools(root, "trigger"), ["Edit", "Write"]);
  assert.deepEqual(grantedTools(root, "routing"), ["Agent", "Bash"]);
  assert.deepEqual(grantedTools(root, "none"), []);
  assert.deepEqual(grantedTools(join(root, "missing"), "trigger"), []);
});

void test("--show-traces keeps the temp dirs, prints each trace path and makes it readable", () => {
  const f = fixture([
    { id: "r", startedAt: "2026-01-01T00:00:00.000Z", trace: true },
  ]);
  const [temp] = f.temps;
  assert.ok(temp);
  mkdirSync(join(temp, "sealed"));
  chmodSync(join(temp, "out", "trace.jsonl"), 0o444);
  chmodSync(join(temp, "out"), 0o500);
  chmodSync(join(temp, "sealed"), 0o000);
  chmodSync(temp, 0o500);
  const lines: string[] = [];
  record(
    {
      pluginDir: f.pluginDir,
      dirs: [],
      commit: null,
      model: "claude-test-1",
      since: null,
      dirty: null,
      cleanTemp: false,
      showTraces: true,
      allow: null,
      printAllow: null,
      sweepTemp: false,
    },
    (l) => lines.push(l),
  );
  const trace = join(temp, "out", "trace.jsonl");
  assert.ok(lines.includes(`trace: ${trace}`), lines.join("\n"));
  assert.match(readFileSync(trace, "utf8"), /claude-test-1/);
  assert.equal(parseArgs(["p", "--show-traces"]).showTraces, true);
  assert.equal(exposeTrace(temp), trace);
  assert.equal(statSync(temp).mode & 0o755, 0o755);
  assert.equal(statSync(join(temp, "out")).mode & 0o755, 0o755);
  assert.equal(
    statSync(join(temp, "sealed")).mode & 0o777,
    0o000,
    "sealed stays sealed",
  );
  chmodSync(join(temp, "sealed"), 0o700);
});
