// The run contract v2 kit (docs/guard.md, "Run contract v2"). An external runner runs it as one CI job against a
// pinned checkout of this repo:
//
//   make contract-test MANIFEST=<absolute path to the runner's installed manifest>
//
// `make test` runs it too, with the bundled fixture (fixtures/acme-runner.json) as the subject; the scenarios that
// need a manifest installed out of the user's reach are then skipped. Scenarios marked pending cover decisions that
// land in guard 1.0.0.

// Spawned guards inherit these: no telemetry, no stop check, no fake events in a real run's file.
process.env.GUARD_OTEL = "off";
process.env.GUARD_STOP_CHECK = "off";
process.env.FACTORY_EVENTS_FILE = "";

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  UNREGISTERED_RULE,
  parseRegistration,
  unregisteredLine,
  validateRegistration,
} from "../../plugins/guard/core/registration.mjs";
import { DEFAULT_PROTECTED_LIMITS } from "../../plugins/guard/core/constants.mjs";
import { prepareChecker } from "../../plugins/guard/hooks/checker.mjs";
import {
  loadRegistration,
  pinFile,
  type Loaded,
} from "../../plugins/guard/hooks/registration.mjs";

const MANIFEST = process.env.CONTRACT_MANIFEST;
const FIXTURE = fileURLToPath(
  new URL("./fixtures/acme-runner.json", import.meta.url),
);
const GUARD = fileURLToPath(
  new URL("../../plugins/guard/hooks/guard.mjs", import.meta.url),
);
const pathApi = process.platform === "win32" ? path.win32 : path;
const subject = MANIFEST ?? FIXTURE;
const NEEDS_MANIFEST =
  "needs MANIFEST=<abs path> installed out of this user's reach";
const skipUnlessManifest = MANIFEST ? false : NEEDS_MANIFEST;

const dataDir = mkdtempSync(path.join(os.tmpdir(), "contract-kit-"));
after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

interface Subject {
  requires: string[];
  labels?: Record<string, unknown>;
  modes?: string[];
  result?: { checker?: string };
  [key: string]: unknown;
}
const subjectJson = (): Subject =>
  JSON.parse(readFileSync(subject, "utf8")) as Subject;
const validate = (value: unknown) =>
  validateRegistration(value, DEFAULT_PROTECTED_LIMITS, pathApi);
const errorsOf = (v: ReturnType<typeof validate>): string[] =>
  v.ok ? [] : v.errors;

const denied = (l: Loaded): { rule: string; why: string } => {
  if (l.state !== "deny") assert.fail(`expected a deny, got ${l.state}`);
  return l;
};

void test("contract: MANIFEST is an absolute path", () => {
  if (MANIFEST !== undefined) {
    assert.ok(
      pathApi.isAbsolute(MANIFEST),
      `MANIFEST must be an absolute path, got ${MANIFEST}`,
    );
  }
});

void test("contract: the guard probe reports contract 2 and the required capabilities", () => {
  const r = spawnSync(process.execPath, [GUARD, "--contract"], {
    input: "",
    timeout: 10000,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `probe exited ${String(r.status)}: ${r.stderr}`);
  const lines = r.stdout.split("\n").filter((l) => l.trim());
  assert.equal(lines.length, 1, `expected one JSON line, got: ${r.stdout}`);
  const probe = JSON.parse(lines[0] ?? "") as {
    contract?: unknown;
    guard?: unknown;
    capabilities?: unknown;
  };
  assert.equal(probe.contract, 2);
  assert.equal(typeof probe.guard, "string");
  assert.ok(Array.isArray(probe.capabilities));
  const missing = subjectJson().requires.filter(
    (c) => !(probe.capabilities as string[]).includes(c),
  );
  assert.deepEqual(
    missing,
    [],
    `guard lacks capabilities: ${missing.join(", ")}`,
  );
});

void test("contract: the manifest validates", () => {
  const v = parseRegistration(
    readFileSync(subject),
    DEFAULT_PROTECTED_LIMITS,
    pathApi,
  );
  assert.ok(v.ok, `invalid manifest: ${errorsOf(v).join("; ")}`);
});

const runEnv = (): Record<string, string | undefined> => ({
  GUARD_RUN_MANIFEST: MANIFEST,
  GUARD_RUN_ID: "contract-test-1",
  GUARD_RUN_TICKET: "acme/app#1",
  GUARD_RUN_MODE: subjectJson().modes?.[0] ?? "unattended",
});

void test(
  "contract: the manifest loads with trust",
  { skip: skipUnlessManifest },
  () => {
    const loaded = loadRegistration(runEnv(), {
      dataDir,
      sessionId: "contract-load",
    });
    if (loaded.state !== "registered") {
      assert.fail(loaded.state === "deny" ? loaded.why : "no registration");
    }
    if (subjectJson().result?.checker) {
      assert.ok(loaded.checker, "result.checker is set but not returned");
    }
  },
);

void test("contract: an unknown capability is refused", () => {
  const m = subjectJson();
  const v = validate({ ...m, requires: [...m.requires, "teleport"] });
  assert.equal(v.ok, false);
  assert.ok(
    errorsOf(v).some((e) => e.includes("unknown capability")),
    errorsOf(v).join("; "),
  );
});

void test("contract: another contract major is refused", () => {
  for (const contract of [3, "2"]) {
    const v = validate({ ...subjectJson(), contract });
    assert.equal(v.ok, false, `contract ${JSON.stringify(contract)}`);
    assert.ok(
      errorsOf(v).some((e) => e.includes("contract must be 2")),
      errorsOf(v).join("; "),
    );
  }
});

void test("contract: an unknown key is refused at any level", () => {
  const m = subjectJson();
  for (const value of [
    { ...m, extra: 1 },
    { ...m, labels: { ...m.labels, extra: 1 } },
  ]) {
    const v = validate(value);
    assert.equal(v.ok, false);
    assert.ok(
      errorsOf(v).some((e) => e.includes("unknown key")),
      errorsOf(v).join("; "),
    );
  }
});

void test("contract: a missing manifest denies", () => {
  const loaded = loadRegistration(
    {
      GUARD_RUN_MANIFEST: path.join(dataDir, "missing.json"),
      GUARD_RUN_ID: "contract-test-1",
    },
    { dataDir, sessionId: "contract-missing" },
  );
  const d = denied(loaded);
  assert.equal(d.rule, "run-registration");
  assert.match(d.why, /no such file/);
});

void test("contract: the run variables out of step deny", () => {
  const noManifest = loadRegistration(
    { GUARD_RUN_ID: "contract-test-1" },
    { dataDir, sessionId: "contract-step-1" },
  );
  assert.match(
    denied(noManifest).why,
    /GUARD_RUN_ID is set but GUARD_RUN_MANIFEST is not/,
  );
  const noId = loadRegistration(
    { GUARD_RUN_MANIFEST: subject },
    { dataDir, sessionId: "contract-step-2" },
  );
  assert.match(
    denied(noId).why,
    /GUARD_RUN_MANIFEST is set but GUARD_RUN_ID is not/,
  );
});

void test("contract: a manifest this user can write is refused", () => {
  const copy = path.join(dataDir, "writable-manifest.json");
  copyFileSync(subject, copy);
  const loaded = loadRegistration(
    { GUARD_RUN_MANIFEST: copy, GUARD_RUN_ID: "contract-test-1" },
    { dataDir, sessionId: "contract-writable" },
  );
  assert.match(denied(loaded).why, /writable by this user/);
});

void test("contract: a checker this user can write is refused", () => {
  const checker = path.join(dataDir, "writable-checker.mjs");
  writeFileSync(checker, "export function resultErrors() { return []; }\n");
  const prepared = prepareChecker(checker);
  assert.ok("why" in prepared, "a writable checker was accepted");
  if ("why" in prepared) assert.match(prepared.why, /writable by this user/);
});

void test(
  "contract: a manifest changed during the session denies",
  { skip: skipUnlessManifest },
  () => {
    const sessionId = "contract-changed";
    mkdirSync(path.join(dataDir, "sessions"), { recursive: true });
    writeFileSync(
      pinFile(dataDir, sessionId),
      JSON.stringify({
        manifest: realpathSync(subject),
        sha256: "0".repeat(64),
      }) + "\n",
    );
    const loaded = loadRegistration(runEnv(), { dataDir, sessionId });
    assert.match(denied(loaded).why, /changed during the session/);
  },
);

void test("contract: the legacy-only tripwire line has a fixed shape", () => {
  const line = JSON.parse(unregisteredLine()) as Record<string, string>;
  assert.deepEqual(Object.keys(line).sort(), [
    "decision",
    "event",
    "reason",
    "rule",
    "ts",
  ]);
  assert.equal(line.event, UNREGISTERED_RULE);
  assert.equal(line.rule, UNREGISTERED_RULE);
  assert.equal(line.decision, "deny");
  assert.ok(!Number.isNaN(Date.parse(line.ts ?? "")), "ts is not a date");
  assert.ok(!/[/\\]/.test(line.reason ?? ""), "reason carries a path");
});

const PENDING = "pending: the decision wiring lands in guard 1.0.0";
for (const name of [
  "a label approval change is denied",
  "a label takeover change is denied",
  "an unreadable label config denies label changes",
  "a protected path write is denied",
  "an exempt path write is allowed",
  "a gh alias is denied",
  "the events decision line has a fixed shape",
  "a bad result blocks the stop",
  "legacy run variables without a registration trip the legacy-only tripwire",
]) {
  void test(`contract: ${name}`, { skip: PENDING }, () => undefined);
}
