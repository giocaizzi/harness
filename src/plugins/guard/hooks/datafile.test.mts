// The agent can write the guard's data dir, so every hook read of it must refuse a FIFO, a symlink (to a FIFO or to a
// regular file) and an oversized file without hanging: a hook that times out lets the tool call or the stop through.
// Each case runs in a child with a timeout, because a read that blocks cannot be timed out from inside its process.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { appendDataFile, readDataFile, readDataFileStrict } from "./data.mjs";

const root = mkdtempSync(join(tmpdir(), "guard-datafile-"));
after(() => {
  rmSync(root, { recursive: true, force: true });
});
const posix = process.platform === "win32" ? { skip: "no posix" } : {};
const url = (f: string): string => new URL(`./${f}.mjs`, import.meta.url).href;
const SHAPES = ["fifo", "fifolink", "reglink", "big", "ok"] as const;

// Runs `body` in a child; the child prints one JSON line. A hang is a timeout, which fails the test.
const child = (body: string): unknown => {
  const dir = mkdtempSync(join(root, "c-"));
  const script = `
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
const BIG = 5 * 1024 * 1024;
const root = ${JSON.stringify(dir)};
const plant = (shape, p, ok = "") => {
  mkdirSync(dirname(p), { recursive: true });
  rmSync(p, { force: true });
  if (shape === "fifo") execFileSync("mkfifo", [p]);
  else if (shape === "fifolink") { execFileSync("mkfifo", [p + ".t"]); symlinkSync(p + ".t", p); }
  else if (shape === "reglink") { writeFileSync(p + ".t", ok); symlinkSync(p + ".t", p); }
  else if (shape === "big") writeFileSync(p, ok.padEnd(BIG, " "));
  else writeFileSync(p, ok);
};
const out = (v) => console.log(JSON.stringify(v));
${body}
`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 20000,
    env: {
      ...process.env,
      GUARD_OTEL: "off",
      GUARD_STOP_CHECK: "off",
      GUARD_RUN_EVENTS_FILE: "",
      CLAUDE_PLUGIN_DATA: join(dir, "data"),
    },
  });
  assert.equal(r.error, undefined, `hung or failed to run: ${String(r.error)}`);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop() ?? "null");
};

void test(
  "data file helpers: a regular file reads, anything else is refused",
  posix,
  () => {
    const f = join(root, "plain.txt");
    writeFileSync(f, "abc");
    assert.equal(readDataFile(f, 10), "abc");
    assert.equal(readDataFile(f, 2), null);
    assert.equal(readDataFile(join(root, "missing"), 10), null);
    assert.equal(readDataFile(root, 10), null);
    assert.throws(() => readDataFileStrict(f, 2), { code: "EFBIG" });
    assert.throws(() => readDataFileStrict(root, 10), { code: "ENOTREG" });
    assert.throws(() => readDataFileStrict(join(root, "missing"), 10), {
      code: "ENOENT",
    });
    appendDataFile(f, "d");
    assert.equal(readDataFile(f, 10), "abcd");
  },
);

for (const shape of SHAPES) {
  void test(
    `data dir reads (${shape}): the session pin is a pin failure, never a hang`,
    posix,
    () => {
      const r = child(`
const { loadRegistration, pinFile } = await import(${JSON.stringify(url("registration"))});
const m = join(root, "m.json");
writeFileSync(m, JSON.stringify({ contract: 2, runner: "acme-runner", requires: [] }));
const vet = { writable: () => false, owner: () => false, readOnlyMount: () => false };
const env = { GUARD_RUN_ID: "r1", GUARD_RUN_MANIFEST: m };
const opts = { vet, dataDir: join(root, "data"), sessionId: "s1" };
loadRegistration(env, opts);
const pin = pinFile(opts.dataDir, "s1");
const good = readFileSync(pin, "utf8");
plant(${JSON.stringify(shape)}, pin, good);
const l = loadRegistration(env, opts);
out({ state: l.state, pin: l.pin === true });
`);
      assert.deepEqual(
        r,
        shape === "ok"
          ? { state: "registered", pin: false }
          : { state: "deny", pin: true },
      );
    },
  );

  void test(
    `data dir reads (${shape}): the session facts are no facts, never a hang`,
    posix,
    () => {
      const r = child(`
const { sessionStore } = await import(${JSON.stringify(url("guard"))});
const dir = join(root, "data");
plant(${JSON.stringify(shape)}, join(dir, "sessions", "s1.jsonl"), '{"loaded":"x"}\\n');
out(sessionStore(dir, "s1").load().loaded);
`);
      assert.deepEqual(r, shape === "ok" ? ["x"] : []);
    },
  );

  void test(
    `data dir reads (${shape}): the green cache is not green, never a hang`,
    posix,
    () => {
      const r = child(`
const { lastGreen, stateFile } = await import(${JSON.stringify(url("stop"))});
plant(${JSON.stringify(shape)}, stateFile("/some/repo"), "abc\\ndef");
out(lastGreen("/some/repo"));
`);
      assert.deepEqual(r, shape === "ok" ? { fp: "abc", head: "def" } : {});
    },
  );

  void test(
    `data dir reads (${shape}): the stop-check lock is taken over unless a live regular file holds it, never a hang`,
    posix,
    () => {
      const r = child(`
const { takeLock } = await import(${JSON.stringify(url("stop"))});
const f = join(root, "data", "stop", "x.lock");
plant(${JSON.stringify(shape)}, f, String(process.pid));
out(takeLock(f) === null);
`);
      // a live holder in a regular file keeps the lock; a refused file is a stale lock and is replaced
      assert.equal(r, shape === "ok");
    },
  );
}

// Through the hooks: a FIFO pin and FIFO facts neither hang, nor release a stop, nor allow a protected write.
void test(
  "data dir FIFOs through handle() and resultGate: no hang, the stop stays blocked, the protected write is denied",
  posix,
  () => {
    const r = child(`
const { handle } = await import(${JSON.stringify(url("guard"))});
const { resultGate } = await import(${JSON.stringify(url("stop"))});
const { pinFile } = await import(${JSON.stringify(url("registration"))});
const repo = join(root, "repo");
mkdirSync(repo, { recursive: true });
execFileSync("git", ["init", "-q", repo]);
const m = join(root, "m.json");
writeFileSync(m, JSON.stringify({
  contract: 2, runner: "acme-runner", requires: ["protected-paths", "result-gate"],
  protected_paths: { globs: [".acme/**"] },
  result: { file: ".acme/runs/{ticket_number}/result.json" },
}));
const dataDir = join(root, "data");
const env = { GUARD_RUN_ID: "r1", GUARD_RUN_TICKET: "acme/app#12", GUARD_RUN_MANIFEST: m };
const vet = { writable: () => false, owner: () => false, readOnlyMount: () => false };
const call = async (command) => {
  const res = await handle(
    { session_id: "s1", cwd: repo, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } },
    { dataDir, env, runVet: vet, hostFacts: async () => ({ load1: 1, freeGb: 100 }), run: async () => null },
  );
  const o = res.stdout ? JSON.parse(res.stdout).hookSpecificOutput : {};
  return { d: o.permissionDecision, why: o.permissionDecisionReason ?? "" };
};
const gate = async () =>
  (await resultGate({ cwd: repo, session_id: "s1" }, undefined, env, undefined, { ...vet, dataDir })) ?? "";
const res = {};
res.first = await call("echo x > .github/workflows/ci.yml");
res.firstGate = await gate();
plant("fifo", join(dataDir, "sessions", "s1.jsonl"));
res.factsFifo = await call("echo x > .github/workflows/ci.yml");
plant("fifo", pinFile(dataDir, "s1"));
res.pinFifo = await call("echo x > .github/workflows/ci.yml");
res.gateFifo = await gate();
res.gateLink = (plant("fifolink", pinFile(dataDir, "s1")), await gate());
out(res);
`) as Record<string, unknown>;
    const first = r.first as { d: string; why: string };
    assert.equal(first.d, "deny");
    assert.match(first.why, /protected path/);
    assert.match(r.firstGate as string, /Run result gate/);
    const facts = r.factsFifo as { d: string; why: string };
    assert.equal(facts.d, "deny");
    assert.match(facts.why, /protected path/);
    assert.equal((r.pinFifo as { d: string }).d, "deny");
    assert.match(r.gateFifo as string, /Run result gate/);
    assert.match(r.gateLink as string, /Run result gate/);
  },
);

// The tripwire log is a data-dir file too: a FIFO or a symlink at its path is neither blocked on nor written through,
// and the legacy-only deny stands.
for (const shape of ["fifo", "fifolink", "reglink"] as const) {
  void test(
    `data dir writes (${shape}): the tripwire log is lost, the legacy-only deny stands, never a hang`,
    posix,
    () => {
      const r = child(`
const { handle } = await import(${JSON.stringify(url("guard"))});
const dataDir = join(root, "data");
const log = join(dataDir, "run-unregistered.jsonl");
plant(${JSON.stringify(shape)}, log, "");
const res = await handle(
  { session_id: "s1", cwd: root, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } },
  { dataDir, env: { FACTORY_RUN_ID: "r1" }, hostFacts: async () => ({ load1: 1, freeGb: 100 }), run: async () => null },
);
const o = res.stdout ? JSON.parse(res.stdout).hookSpecificOutput : {};
out({
  d: o.permissionDecision,
  rule: /GUARD_RUN_MANIFEST/.test(o.permissionDecisionReason ?? ""),
  target: ${JSON.stringify(shape)} === "reglink" ? readFileSync(log + ".t", "utf8") : "",
});
`) as { d: string; rule: boolean; target: string };
      assert.deepEqual(r, { d: "deny", rule: true, target: "" });
    },
  );
}
