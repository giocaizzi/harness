// Run contract v2 run context: which run a hook call belongs to, the facts the shell and edit rules read, the deny texts
// and the tripwire's line. The manifest is trusted through the vet probes (the real vet needs a file out of the test
// user's reach).

import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { pinFile } from "./registration.mjs";
import type { RegisteredRun, RunContext, RunDeny } from "./run.mjs";
import {
  denyReason,
  LEGACY_VARS,
  legacySet,
  recordUnregistered,
  runContext,
  runFacts,
  unregisteredLog,
} from "./run.mjs";

const root = realpathSync(mkdtempSync(join(tmpdir(), "guard-run-ctx-")));
after(() => {
  rmSync(root, { recursive: true, force: true });
});
const vet = {
  writable: () => false,
  owner: () => false,
  readOnlyMount: () => false,
};
let n = 0;
const manifest = (body: Record<string, unknown>): string => {
  const file = join(root, `m${String(n++)}.json`);
  writeFileSync(
    file,
    JSON.stringify({ contract: 2, runner: "acme-runner", ...body }),
  );
  return file;
};
const envFor = (
  file: string,
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> => ({
  GUARD_RUN_ID: "r1",
  GUARD_RUN_MANIFEST: file,
  ...extra,
});
const reg = (env: Record<string, string | undefined>): RegisteredRun => {
  const ctx = runContext(env, { vet });
  assert.equal(ctx.state, "registered", JSON.stringify(ctx));
  return ctx;
};
const denied = (ctx: RunContext): RunDeny => {
  assert.equal(ctx.state, "deny", JSON.stringify(ctx));
  return ctx;
};

void test("runContext: no run variable is none, blank values included", () => {
  assert.deepEqual(runContext({}, { vet }), { state: "none" });
  assert.deepEqual(
    runContext(
      { GUARD_RUN_ID: " ", FACTORY_RUN_ID: "", FACTORY_TICKET: "  " },
      { vet },
    ),
    { state: "none" },
  );
});

void test("runContext: a run id without a manifest (or the reverse) denies with run-registration", () => {
  for (const env of [
    { GUARD_RUN_ID: "r1" },
    { GUARD_RUN_MANIFEST: "/x/m.json" },
    { GUARD_RUN_ID: "r1", GUARD_RUN_MANIFEST: join(root, "missing.json") },
  ]) {
    const d = denied(runContext(env, { vet }));
    assert.equal(d.rule, "run-registration", JSON.stringify(env));
    assert.ok(d.why.length > 0);
  }
});

void test("runContext: each legacy variable alone trips run-unregistered; a registration wins over them", () => {
  for (const k of LEGACY_VARS) {
    const d = denied(runContext({ [k]: "x" }, { vet }));
    assert.equal(d.rule, "run-unregistered", k);
    assert.equal(legacySet({ [k]: "x" }), true, k);
    assert.equal(runContext({ [k]: "" }, { vet }).state, "none", k);
    assert.equal(runContext({ [k]: "  " }, { vet }).state, "none", k);
  }
  const file = manifest({ requires: [] });
  assert.equal(
    reg(envFor(file, { FACTORY_RUN_ID: "r9", FACTORY_TICKET: "x" })).state,
    "registered",
  );
});

void test("runContext: a registered run carries its mode, ticket, run file and extra globs", () => {
  const file = manifest({ requires: [] });
  const plain = reg(envFor(file));
  assert.equal(plain.mode, "unattended");
  assert.equal(plain.runId, "r1");
  assert.equal(plain.ticket, undefined);
  assert.equal(plain.runFile, undefined);
  assert.deepEqual(plain.extra, []);
  assert.equal(plain.registration.runner, "acme-runner");
  assert.match(plain.sha256, /^[0-9a-f]{64}$/);
  assert.equal(plain.path, realpathSync(file));
  const full = reg(
    envFor(file, {
      GUARD_RUN_MODE: "attended",
      GUARD_RUN_TICKET: "acme/app#42",
      GUARD_RUN_FILE: " .acme/runs/42/result.json ",
      GUARD_RUN_PROTECTED_PATHS: " infra/** \r\n\n deploy/*.tf\n",
    }),
  );
  assert.equal(full.mode, "attended");
  assert.equal(full.ticket, "acme/app#42");
  assert.equal(full.ticketNumber, "42");
  assert.equal(full.runFile, ".acme/runs/42/result.json");
  assert.deepEqual(full.extra, ["infra/**", "deploy/*.tf"]);
  assert.equal(reg(envFor(file, { GUARD_RUN_MODE: "" })).mode, "unattended");
});

void test("runContext: a session id and data dir pin the manifest, a changed one denies", () => {
  const dataDir = mkdtempSync(join(root, "data-"));
  const file = manifest({ requires: [] });
  const opts = { vet, dataDir, sessionId: "s1" };
  assert.equal(runContext(envFor(file), opts).state, "registered");
  writeFileSync(
    file,
    JSON.stringify({ contract: 2, runner: "acme-other", requires: [] }),
  );
  chmodSync(file, 0o600);
  const d = denied(runContext(envFor(file), opts));
  assert.equal(d.rule, "run-registration");
  assert.match(d.why, /changed during the session/);
  assert.ok(readFileSync(pinFile(dataDir, "s1"), "utf8").includes("sha256"));
});

void test("runFacts: an attended run has none; labels and protect map from the registration", () => {
  const file = manifest({
    requires: ["labels", "protected-paths"],
    labels: {
      approval: "go-ahead",
      takeover: "hand-over",
      protected: ["acme-parked"],
    },
    protected_paths: {
      globs: ["out/**"],
      exempt: ["out/runs/*/*/**"],
    },
  });
  const attended = reg(envFor(file, { GUARD_RUN_MODE: "attended" }));
  assert.equal(runFacts(attended, { cwd: "/r", root: "/r" }), null);
  const run = reg(envFor(file, { GUARD_RUN_PROTECTED_PATHS: "infra/**" }));
  assert.deepEqual(runFacts(run, { cwd: "/r/src", root: "/r" }), {
    labels: {
      approval: "go-ahead",
      takeover: "hand-over",
      protected: ["acme-parked"],
    },
    protect: {
      cwd: "/r/src",
      root: "/r",
      registered: ["out/**"],
      exempt: ["out/runs/*/*/**"],
      extra: ["infra/**"],
    },
  });
});

void test("runFacts: a registration that requires labels but names none is unsure; one that does not require them is not", () => {
  const at = { cwd: "/r", root: "/r" };
  const unsure = runFacts(reg(envFor(manifest({ requires: ["labels"] }))), at);
  assert.ok(unsure);
  assert.equal(unsure.unsure, true);
  assert.equal(unsure.labels, undefined);
  const plain = runFacts(reg(envFor(manifest({ requires: [] }))), at);
  assert.ok(plain);
  assert.equal(plain.unsure, undefined);
  assert.equal(plain.labels, undefined);
  assert.deepEqual(
    [plain.protect?.registered, plain.protect?.exempt],
    [[], []],
  );
  const named = runFacts(
    reg(
      envFor(
        manifest({ requires: ["labels"], labels: { protected: ["acme-x"] } }),
      ),
    ),
    at,
  );
  assert.ok(named);
  assert.equal(named.unsure, undefined);
  assert.deepEqual(named.labels, { protected: ["acme-x"] });
});

void test("denyReason: the texts say what to do and carry no env value", () => {
  const env = {
    GUARD_RUN_ID: "secret-run-id",
    FACTORY_RUN_ID: "legacy-secret",
    GUARD_RUN_MANIFEST: "/very/secret/path.json",
  };
  const trip = denied(runContext({ FACTORY_RUN_ID: "legacy-secret" }, { vet }));
  const bad = denied(runContext(env, { vet }));
  assert.match(denyReason(trip, "tool"), /GUARD_RUN_MANIFEST/);
  assert.match(
    denyReason(trip, "stop"),
    /^Legacy run variables are set without a run registration/,
  );
  assert.match(denyReason(bad, "tool"), /^Run registration failed: /);
  assert.match(
    denyReason(bad, "stop"),
    /^Run registration failed: .*stop and report it\.$/,
  );
  for (const d of [trip, bad])
    for (const at of ["tool", "stop"] as const)
      assert.match(denyReason(d, at), /every tool call guard sees/i, at);
  for (const d of [trip, bad])
    for (const at of ["tool", "stop"] as const)
      assert.doesNotMatch(
        denyReason(d, at),
        /secret-run-id|legacy-secret/,
        `${d.rule} ${at}`,
      );
});

void test("recordUnregistered: one line per session in guard's log and the legacy events file, in the {ts, event, decision, rule, reason} shape", () => {
  const dir = mkdtempSync(join(root, "tw-"));
  const dataDir = join(dir, "data");
  const events = join(dir, "events.jsonl");
  const now = new Date("2026-03-04T05:06:07.000Z");
  const env = { FACTORY_EVENTS_FILE: events, FACTORY_RUN_ID: "r1" };
  recordUnregistered(env, dataDir, "s1", now);
  recordUnregistered(env, dataDir, "s1", now);
  recordUnregistered(env, dataDir, "s2", now);
  const own = readFileSync(unregisteredLog(dataDir), "utf8").trim().split("\n");
  assert.equal(own.length, 2, "once per session");
  assert.deepEqual(readFileSync(events, "utf8").trim().split("\n"), own);
  const line = JSON.parse(own[0] ?? "") as Record<string, unknown>;
  assert.deepEqual(Object.keys(line), [
    "ts",
    "event",
    "decision",
    "rule",
    "reason",
  ]);
  assert.equal(line.ts, "2026-03-04T05:06:07.000Z");
  assert.equal(line.event, "run-unregistered");
  assert.equal(line.decision, "deny");
  assert.equal(line.rule, "run-unregistered");
  assert.doesNotMatch(own.join("\n"), /r1|events\.jsonl/);
  // Without a session id every call writes.
  const other = join(dir, "other");
  recordUnregistered({}, other, undefined, now);
  recordUnregistered({}, other, undefined, now);
  assert.equal(
    readFileSync(unregisteredLog(other), "utf8").trim().split("\n").length,
    2,
  );
});

void test("recordUnregistered: a very long session key still writes once", () => {
  const dir = mkdtempSync(join(root, "tw-long-"));
  const dataDir = join(dir, "data");
  const key = `${"x".repeat(150)}/${"y".repeat(150)}:12345`;
  assert.equal(key.length > 300, true);
  recordUnregistered({}, dataDir, key);
  recordUnregistered({}, dataDir, key);
  assert.equal(
    readFileSync(unregisteredLog(dataDir), "utf8").trim().split("\n").length,
    1,
  );
});

void test("recordUnregistered: an unwritable path never throws", () => {
  const dir = mkdtempSync(join(root, "tw-"));
  const blocker = join(dir, "file");
  writeFileSync(blocker, "x");
  assert.doesNotThrow(() => {
    recordUnregistered(
      { FACTORY_EVENTS_FILE: join(blocker, "e.jsonl") },
      join(blocker, "data"),
      "s1",
    );
  });
  mkdirSync(join(dir, "ok"));
  assert.doesNotThrow(() => {
    recordUnregistered(
      { FACTORY_EVENTS_FILE: join(dir, "missing", "e.jsonl") },
      join(dir, "ok", "data"),
    );
  });
});
