// The --describe hook descriptor: shape, parsing of every shipped command, and the one JSON line on the CLI.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { install } from "../../../scripts/install.mjs";
import { CONTRACT } from "../core/registration.mjs";
import { guardVersion } from "./contract.mjs";
import { RULE_IDS } from "../core/toggles.mjs";
import {
  RUN_ENV,
  SWITCH_ENV,
  antigravityHooks,
  buildDescriptor,
  commandToArgv,
  describeInstalled,
  flattenHooks,
} from "./describe.mjs";
import type { HookMap } from "./describe.mjs";

// The emitted test sits in plugins/guard/hooks, so ".." is the plugin root.
const guardDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const hooksFile = (file: string): { hooks: Record<string, unknown> } =>
  JSON.parse(readFileSync(join(guardDir, file), "utf8")) as {
    hooks: Record<string, unknown>;
  };
const d = describeInstalled(guardDir);

function harness(name: string): HookMap {
  const h = d.harnesses[name];
  assert.ok(h?.kind === "command", name);
  return h.hooks;
}

void test("describe: top-level shape", () => {
  assert.equal(d.descriptor, 1);
  assert.equal(d.guard, guardVersion(guardDir));
  assert.equal(d.contract, CONTRACT);
  assert.equal(d.root, guardDir);
  assert.deepEqual(Object.keys(d.harnesses).sort(), [
    "antigravity",
    "claude-code",
    "codex-cli",
    "copilot-cli",
    "opencode",
    "pi",
    "vscode-copilot",
  ]);
  assert.deepEqual(d.env, { run: RUN_ENV, switches: SWITCH_ENV });
  assert.ok(SWITCH_ENV.includes("GUARD_RULES"));
  assert.deepEqual(Object.keys(d.rules).sort(), [...RULE_IDS].sort());
  assert.ok(RUN_ENV.includes("AGENT_RUN_MANIFEST_SHA256"));
  assert.deepEqual(d.harnesses.opencode, {
    kind: "module",
    module: join(guardDir, "hooks", "opencode.mjs"),
  });
  assert.deepEqual(d.harnesses.pi, {
    kind: "module",
    module: join(guardDir, "hooks", "pi.mjs"),
  });
  assert.deepEqual(d.harnesses["copilot-cli"], d.harnesses["claude-code"]);
  assert.deepEqual(d.harnesses["vscode-copilot"], d.harnesses["claude-code"]);
});

void test("describe: every hooks.json event is present for claude-code, one entry per command", () => {
  const raw = hooksFile(join("hooks", "hooks.json")).hooks;
  const got = harness("claude-code");
  assert.deepEqual(Object.keys(got), Object.keys(raw));
  for (const [event, groups] of Object.entries(raw)) {
    const n = (groups as { hooks: unknown[] }[]).reduce(
      (sum, g) => sum + g.hooks.length,
      0,
    );
    assert.equal(got[event]?.length, n, event);
  }
  const stop = got.Stop?.at(0);
  const pre = got.PreToolUse?.at(0);
  assert.ok(stop && pre);
  assert.equal(stop.timeout, 1800);
  assert.equal(stop.matcher, undefined);
  assert.ok(pre.matcher?.startsWith("Bash|"));
});

void test("describe: argv paths are absolute, existing, and need no variable", () => {
  for (const name of ["claude-code", "codex-cli", "antigravity"]) {
    for (const entries of Object.values(harness(name))) {
      for (const e of entries) {
        assert.equal(e.argv[0], "node");
        const script = e.argv[1] ?? "";
        assert.ok(isAbsolute(script), script);
        assert.ok(existsSync(script), script);
        assert.ok(!e.argv.join(" ").includes("${"), script);
      }
    }
  }
  for (const k of ["opencode", "pi"]) {
    const h = d.harnesses[k];
    assert.ok(h?.kind === "module" && existsSync(h.module), k);
  }
});

void test("describe: codex entries carry --harness=codex", () => {
  const codex = harness("codex-cli");
  assert.deepEqual(Object.keys(codex), Object.keys(harness("claude-code")));
  for (const entries of Object.values(codex)) {
    for (const e of entries) assert.ok(e.argv.includes("--harness=codex"));
  }
});

void test("describe: every shipped command parses", () => {
  for (const file of [
    join("hooks", "hooks.json"),
    join(".generated", "codex", "hooks.json"),
  ]) {
    for (const groups of Object.values(hooksFile(file).hooks)) {
      for (const g of groups as { hooks: { command: string }[] }[]) {
        for (const h of g.hooks) {
          assert.doesNotThrow(
            () => commandToArgv(h.command, guardDir),
            h.command,
          );
        }
      }
    }
  }
});

void test("describe: a command outside the simple form fails loudly", () => {
  for (const bad of [
    "node guard.mjs",
    'node "${CLAUDE_PLUGIN_ROOT}/hooks/x.mjs" "quoted arg"',
    'node "${CLAUDE_PLUGIN_ROOT}/hooks/x.mjs" a | b',
    'sh "${CLAUDE_PLUGIN_ROOT}/hooks/x.sh"',
  ]) {
    assert.throws(() => commandToArgv(bad, "/r"), /unparseable/, bad);
  }
  assert.deepEqual(
    commandToArgv('node "${CLAUDE_PLUGIN_ROOT}/hooks/x.mjs" A --b', "/r"),
    ["node", join("/r", "hooks/x.mjs"), "A", "--b"],
  );
  assert.throws(() => flattenHooks({ Stop: {} }, "/r"), /not a list/);
  assert.throws(
    () =>
      buildDescriptor(
        "/r",
        () => '{"hooks":{"Stop":[{"hooks":[{}]}]}}',
        "1.0.0",
      ),
    /without a command/,
  );
});

void test("describe: antigravity matches what install writes", () => {
  const dir = mkdtempSync(join(tmpdir(), "describe-agy-"));
  install("antigravity", dir);
  const written = JSON.parse(
    readFileSync(join(dir, "hooks.json"), "utf8"),
  ) as Record<string, Record<string, unknown>>;
  const installed = written["giocaizzi-guard"] ?? {};
  // install writes from the repo's plugins/guard, the descriptor from the copy this test runs in: the same tree.
  assert.deepEqual(installed, antigravityHooks(guardDir));
  assert.deepEqual(harness("antigravity"), flattenHooks(installed, guardDir));
  assert.equal(
    harness("antigravity").PreToolUse?.[0]?.argv.at(-1),
    "--harness=antigravity",
  );
  assert.deepEqual(Object.keys(harness("antigravity")), ["PreToolUse", "Stop"]);
});

void test("describe: guard.mjs --describe prints one JSON line and exits 0 with stdin closed", () => {
  const r = spawnSync(
    process.execPath,
    [join(guardDir, "hooks", "guard.mjs"), "--describe"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10000,
      env: { ...process.env, GUARD_OTEL: "off" },
    },
  );
  assert.equal(r.status, 0);
  assert.equal(r.stderr, "");
  assert.match(r.stdout, /^[^\n]+\n$/);
  assert.deepEqual(JSON.parse(r.stdout), JSON.parse(JSON.stringify(d)));
});

void test("describe: rules are the effective toggles of the probe's environment", () => {
  const read = (relative: string): string =>
    readFileSync(join(guardDir, relative), "utf8");
  const on = buildDescriptor(guardDir, read, "x");
  assert.ok(RULE_IDS.every((id) => on.rules[id]));
  const some = buildDescriptor(guardDir, read, "x", {
    GUARD_RULES: "none,risky,result-gate",
  });
  assert.deepEqual(
    RULE_IDS.filter((id) => some.rules[id]),
    ["risky", "result-gate"],
  );
  // an invalid value keeps every rule on
  const bad = buildDescriptor(guardDir, read, "x", {
    GUARD_RULES: "none,nope",
  });
  assert.ok(RULE_IDS.every((id) => bad.rules[id]));
  // an older switch still turns its rule off
  assert.equal(
    buildDescriptor(guardDir, read, "x", { GUARD_STOP_CHECK: "off" }).rules[
      "stop-check"
    ],
    false,
  );
});
