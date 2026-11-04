// The --contract probe: guard's version lookup and the one JSON line a launcher reads.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { CAPABILITIES } from "../core/registration.mjs";
import { ENFORCED, contractProbe, guardVersion } from "./contract.mjs";

const root = mkdtempSync(join(tmpdir(), "guard-contract-"));
after(() => {
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
function pluginWith(manifest: string | null): string {
  const dir = join(root, `p${String(n++)}`);
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  if (manifest !== null) {
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), manifest);
  }
  return dir;
}

void test("contract probe: guardVersion reads a valid version", () => {
  assert.equal(guardVersion(pluginWith('{"version":"1.2.3"}')), "1.2.3");
  assert.equal(
    guardVersion(pluginWith('{"version":"1.2.3-rc.1"}')),
    "1.2.3-rc.1",
  );
});

void test("contract probe: guardVersion falls back to unknown", () => {
  assert.equal(guardVersion(pluginWith(null)), "unknown");
  assert.equal(guardVersion(pluginWith("{not json")), "unknown");
  assert.equal(guardVersion(pluginWith("null")), "unknown");
  assert.equal(guardVersion(pluginWith('{"version":2}')), "unknown");
  assert.equal(guardVersion(pluginWith('{"version":"1.2"}')), "unknown");
  assert.equal(guardVersion(pluginWith('{"version":"v1.2.3"}')), "unknown");
});

void test("contract probe: contractProbe shape", () => {
  assert.deepEqual(contractProbe("9.9.9"), {
    contract: 2,
    capabilities: [...CAPABILITIES],
    enforced: ENFORCED,
    guard: "9.9.9",
  });
});

void test("contract probe: guard.mjs --contract prints one JSON line", () => {
  // The emitted test sits in plugins/guard/hooks, so ".." is the plugin root.
  const guardDir = fileURLToPath(new URL("..", import.meta.url));
  const manifest = JSON.parse(
    readFileSync(join(guardDir, ".claude-plugin", "plugin.json"), "utf8"),
  ) as { version: string };
  const r = spawnSync(
    process.execPath,
    [join(guardDir, "hooks", "guard.mjs"), "--contract"],
    {
      encoding: "utf8",
      input: "",
      timeout: 10000,
      env: { ...process.env, GUARD_OTEL: "off" },
    },
  );
  assert.equal(r.status, 0);
  assert.equal(r.stderr, "");
  assert.match(r.stdout, /^[^\n]+\n$/);
  const out = JSON.parse(r.stdout) as Record<string, unknown>;
  assert.equal(out.contract, 2);
  assert.deepEqual(out.capabilities, [...CAPABILITIES]);
  assert.equal(typeof out.enforced, "boolean");
  assert.equal(out.enforced, ENFORCED);
  assert.equal(out.enforced, true, "enforced from guard 1.0.0");
  assert.equal(out.guard, manifest.version);
});
