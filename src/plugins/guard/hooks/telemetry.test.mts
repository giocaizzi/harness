import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { canonicalHarnessName } from "./harnesses.mjs";
import {
  appendDecision,
  commandHash,
  emitAntigravityUsage,
  failedTarget,
  guardVersion,
  harnessName,
  recordAttrs,
  repoName,
  repoSlug,
  resolveAntigravityTranscriptPath,
  scrub,
  usageAttributes,
} from "./telemetry.mjs";

void test("harnessName: the --harness flag wins, then the data dir each harness sets", () => {
  assert.equal(
    harnessName(["node", "stop.mjs", "--harness=codex"], {
      CLAUDE_PLUGIN_DATA: "/d",
    }),
    "codex",
  );
  assert.equal(
    harnessName([], {
      CLAUDE_PLUGIN_DATA: "/d",
      CLAUDE_PLUGIN_ROOT: "/r",
    }),
    "claude",
  );
  assert.equal(harnessName([], { COPILOT_PLUGIN_DATA: "/d" }), "copilot");
  assert.equal(harnessName([], { CLAUDE_PLUGIN_ROOT: "/r" }), "vscode");
  assert.equal(harnessName([], {}), "other");
});

void test("canonicalHarnessName: every internal alias maps to its telemetry identity", () => {
  const cases = [
    { alias: "claude", canonical: "claude-code" },
    { alias: "copilot", canonical: "copilot-cli" },
    { alias: "vscode", canonical: "vscode-copilot" },
    { alias: "codex", canonical: "codex-cli" },
    { alias: "opencode", canonical: "opencode" },
    { alias: "pi", canonical: "pi" },
    { alias: "antigravity", canonical: "antigravity" },
    { alias: "other", canonical: "other" },
  ];
  for (const item of cases)
    assert.equal(canonicalHarnessName(item.alias), item.canonical, item.alias);
  assert.equal(canonicalHarnessName("unknown"), "other");
  assert.equal(canonicalHarnessName(undefined), "other");
});

void test("recordAttrs: canonical harness identity and changed legacy aliases are emitted only when enabled", () => {
  assert.deepEqual(recordAttrs({ a: 1 }, "/", "claude", {}), { a: 1 });
  assert.deepEqual(
    recordAttrs({ a: 1 }, "/", "claude", {
      GUARD_OTEL_EXPORTER_OTLP_ENDPOINT: "http://c",
      GUARD_OTEL: "off",
    }),
    { a: 1 },
  );

  const cases = [
    { alias: "claude", canonical: "claude-code", legacy: "claude" },
    { alias: "copilot", canonical: "copilot-cli", legacy: "copilot" },
    { alias: "vscode", canonical: "vscode-copilot", legacy: "vscode" },
    { alias: "codex", canonical: "codex-cli", legacy: "codex" },
    { alias: "opencode", canonical: "opencode" },
    { alias: "pi", canonical: "pi" },
    { alias: "antigravity", canonical: "antigravity" },
    { alias: "other", canonical: "other" },
  ];
  for (const item of cases) {
    const attrs = recordAttrs({ a: 1 }, "/", item.alias, {
      GUARD_OTEL_EXPORTER_OTLP_ENDPOINT: "http://c",
    });
    assert.equal(attrs.harness, item.canonical, item.alias);
    assert.equal(attrs.harness_legacy, item.legacy, item.alias);
    assert.equal(
      "harness_legacy" in attrs,
      item.legacy !== undefined,
      item.alias,
    );
    assert.equal(attrs.guard_version, guardVersion());
    assert.match(String(attrs.guard_version), /^\d+\.\d+\.\d+$/);
  }
});

void test("recordAttrs: a guard.decision keeps its tool_use_id, enabled or not", () => {
  const decision = { rule: "r", tool_use_id: "toolu_1" };
  assert.deepEqual(recordAttrs(decision, "/", "claude", {}), decision);
  const attrs = recordAttrs(decision, "/", "claude", {
    GUARD_OTEL_EXPORTER_OTLP_ENDPOINT: "http://c",
  });
  assert.equal(attrs.tool_use_id, "toolu_1");
  assert.ok(!("trace_id" in attrs) && !("span_id" in attrs));
});

void test("usageAttributes: schema, enrichment, finite supplied numbers and zero are preserved", () => {
  const attrs = usageAttributes({
    harness: "copilot",
    cwd: "/",
    env: { GUARD_OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.invalid" },
    sessionId: " session-1 ",
    model: " model-1 ",
    provider: " provider-1 ",
    inputTokens: 0,
    outputTokens: 12,
    cacheReadTokens: 0,
    cacheCreationTokens: null,
    reasoningTokens: Number.NaN,
    costUsd: 0,
    costSource: "reported",
  });
  assert.deepEqual(attrs, {
    usage_schema: "guard.usage.v1",
    "session.id": "session-1",
    model: "model-1",
    provider: "provider-1",
    input_tokens: 0,
    output_tokens: 12,
    cache_read_tokens: 0,
    cost_usd: 0,
    cost_source: "reported",
    harness: "copilot-cli",
    harness_legacy: "copilot",
    guard_version: guardVersion(),
    repo: null,
  });
});

void test("usageAttributes: null, empty, unavailable and non-finite values are omitted", () => {
  const attrs = usageAttributes({
    harness: "pi",
    cwd: "/",
    env: { GUARD_OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.invalid" },
    sessionId: null,
    model: "  ",
    provider: "",
    inputTokens: undefined,
    outputTokens: Number.POSITIVE_INFINITY,
    cacheReadTokens: null,
    cacheCreationTokens: Number.NEGATIVE_INFINITY,
    reasoningTokens: Number.NaN,
    costUsd: null,
    costSource: null,
  });
  assert.deepEqual(attrs, {
    usage_schema: "guard.usage.v1",
    harness: "pi",
    guard_version: guardVersion(),
    repo: null,
  });
});

void test("usageAttributes: enrichment uses only the observed workspace and omits an absent repo", () => {
  const observedCwds: (string | undefined)[] = [];
  const enrichment = {
    guardVersion: () => "1.2.3",
    repoName: (cwd?: string) => {
      observedCwds.push(cwd);
      return "acme/workspace";
    },
  };
  const env = {
    GUARD_OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.invalid",
  };

  assert.deepEqual(
    usageAttributes(
      { harness: "antigravity", cwd: "/observed/workspace", env },
      enrichment,
    ),
    {
      usage_schema: "guard.usage.v1",
      harness: "antigravity",
      guard_version: "1.2.3",
      repo: "acme/workspace",
    },
  );
  assert.deepEqual(
    usageAttributes({ harness: "antigravity", env }, enrichment),
    {
      usage_schema: "guard.usage.v1",
      harness: "antigravity",
      guard_version: "1.2.3",
    },
  );
  assert.deepEqual(observedCwds, ["/observed/workspace"]);
});

void test("usageAttributes: enrichment performs no version or repo lookup when telemetry is disabled or has no endpoint", () => {
  for (const env of [
    {
      GUARD_OTEL: "off",
      GUARD_OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.invalid",
    },
    {},
  ]) {
    let lookups = 0;
    const failLookup = (): never => {
      lookups++;
      throw new Error("enrichment must not run");
    };
    const attrs = usageAttributes(
      {
        cwd: "/not-used",
        env,
        harness: "opencode",
        inputTokens: 0,
        model: "model-1",
      },
      { guardVersion: failLookup, repoName: failLookup },
    );
    assert.deepEqual(attrs, {
      usage_schema: "guard.usage.v1",
      model: "model-1",
      input_tokens: 0,
      harness: "opencode",
    });
    assert.equal(lookups, 0);
  }
});

void test("repoName: owner/name of the origin remote, else the first remote, once per directory; null outside git", () => {
  let calls = 0;
  const run = (_: string, args: readonly string[]): string => {
    calls++;
    return args.join(" ") === "remote get-url origin"
      ? "git@github.com:acme/widgets.git\n"
      : "";
  };
  assert.equal(repoName("/x/y", run), "acme/widgets");
  assert.equal(repoName("/x/y", run), "acme/widgets");
  assert.equal(calls, 1);
  const noOrigin = (_: string, args: readonly string[]): string => {
    if (args[2] === "origin") throw new Error("no origin");
    return args[0] === "remote" && args.length === 1
      ? "upstream\n"
      : "https://token@example.com/acme/tools\n";
  };
  assert.equal(repoName("/z", noOrigin), "acme/tools");
  assert.equal(
    repoName("/nowhere", () => {
      throw new Error("not a repo");
    }),
    null,
  );
});

void test("repoSlug: owner/name only, never host, user or token", () => {
  assert.equal(repoSlug("https://github.com/acme/widgets.git"), "acme/widgets");
  assert.equal(
    repoSlug("https://x-access-token:abc@github.com/acme/widgets"),
    "acme/widgets",
  );
  assert.equal(repoSlug("git@github.com:acme/widgets.git"), "acme/widgets");
  assert.equal(repoSlug("ssh://git@host:22/acme/widgets/"), "acme/widgets");
  assert.equal(
    repoSlug("https://dev.azure.com/org/proj/_git/widgets"),
    "proj/widgets",
  );
  assert.equal(
    repoSlug("https://gitlab.com/group/sub/widgets.git"),
    "sub/widgets",
  );
  // Local or host-only remotes carry directory names, a host or a port, never an owner/name: null.
  for (const url of [
    "/srv/repos/widgets",
    "/Users/alice/repo",
    "file:///home/bob/work/client/app.git",
    "../sibling/repo",
    "https://git.internal.example/proj.git",
    "ssh://git@host.example:2222/proj.git",
    "C:/Users/alice/repo",
    "https://h/o/r/..",
  ]) {
    assert.equal(repoSlug(url), null, url);
  }
  assert.equal(repoSlug(""), null);
  assert.equal(repoSlug(null), null);
});

void test("scrub: secrets and long tokens are masked, the line is capped", () => {
  assert.equal(scrub("error: TOKEN=abc123 failed"), "error: TOKEN=*** failed");
  assert.equal(scrub("auth: Bearer x"), "auth: *** x");
  assert.equal(scrub("got ghp_abcdefghijklmnopqrstuvwxyz0123"), "got ***");
  assert.equal(scrub("x".repeat(300)).length <= 200, true);
});

void test("failedTarget: the innermost make target that failed", () => {
  assert.equal(
    failedTarget(
      "ok\nmake[1]: *** [Makefile:12: test] Error 1\nmake: *** [check] Error 2",
    ),
    "test",
  );
  assert.equal(failedTarget("make: *** [lint] Error 2"), "lint");
  assert.equal(failedTarget("nothing"), null);
});

void test("commandHash: whitespace does not change it, the command text never shows", () => {
  assert.equal(commandHash("rm  -rf   x"), commandHash(" rm -rf x "));
  assert.match(commandHash("rm -rf x"), /^[0-9a-f]{12}$/);
});

void test("resolveAntigravityTranscriptPath: explicit camel or snake case path wins", () => {
  const noLookup = (): never => {
    throw new Error("explicit paths must not inspect recovered artifacts");
  };
  assert.equal(
    resolveAntigravityTranscriptPath(
      {
        conversationId: "conversation-1",
        homeDir: "/unused",
        transcriptPath: "/explicit/transcript.jsonl",
        transcript_path: "/legacy/transcript.jsonl",
      },
      noLookup,
    ),
    "/explicit/transcript.jsonl",
  );
  assert.equal(
    resolveAntigravityTranscriptPath(
      { transcript_path: "/legacy/transcript.jsonl" },
      noLookup,
    ),
    "/legacy/transcript.jsonl",
  );
});

void test("resolveAntigravityTranscriptPath: prefers the recovered transcript.jsonl", () => {
  const home = mkdtempSync(join(tmpdir(), "guard-antigravity-home-"));
  const logs = join(
    home,
    ".gemini",
    "antigravity-cli",
    "brain",
    "conversation-1",
    ".system_generated",
    "logs",
  );
  mkdirSync(logs, { recursive: true });
  const transcript = join(logs, "transcript.jsonl");
  writeFileSync(transcript, "");
  writeFileSync(join(logs, "transcript_full.jsonl"), "");
  try {
    assert.equal(
      resolveAntigravityTranscriptPath({
        conversationId: "conversation-1",
        homeDir: home,
      }),
      transcript,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

void test("resolveAntigravityTranscriptPath: falls back to recovered transcript_full.jsonl", () => {
  const home = mkdtempSync(join(tmpdir(), "guard-antigravity-home-"));
  const logs = join(
    home,
    ".gemini",
    "antigravity-cli",
    "brain",
    "conversation-1",
    ".system_generated",
    "logs",
  );
  mkdirSync(logs, { recursive: true });
  const transcript = join(logs, "transcript_full.jsonl");
  writeFileSync(transcript, "");
  try {
    assert.equal(
      resolveAntigravityTranscriptPath({
        conversationId: "conversation-1",
        homeDir: home,
      }),
      transcript,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

void test("resolveAntigravityTranscriptPath: rejects missing, unsafe, or absent recovered IDs", () => {
  const home = mkdtempSync(join(tmpdir(), "guard-antigravity-home-"));
  try {
    for (const conversationId of [
      undefined,
      "",
      " ",
      ".",
      "..",
      "../escape",
      "nested/id",
      "nested\\id",
      "nul\0id",
      "missing-conversation",
    ]) {
      assert.equal(
        resolveAntigravityTranscriptPath({ conversationId, homeDir: home }),
        undefined,
        conversationId ?? "undefined",
      );
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

void test("emitAntigravityUsage: preserves tokens without emitting cost and advances step", async () => {
  const dir = tmpdir();
  const transcript = join(
    dir,
    `transcript-test-${Date.now().toString()}.jsonl`,
  );
  const lines = [
    JSON.stringify({
      step_index: 0,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      content: "hello",
    }),
    JSON.stringify({
      step_index: 1,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_tokens: 100,
    }),
    JSON.stringify({
      step_index: 2,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      input_tokens: 2000,
      output_tokens: 400,
      cache_read_tokens: 0,
    }),
  ];
  writeFileSync(transcript, lines.join("\n") + "\n");

  const emitted: Record<string, unknown>[] = [];
  const emitFn = (
    event: string,
    attrs: Record<string, unknown>,
  ): Promise<void> => {
    emitted.push({ event, ...attrs });
    return Promise.resolve();
  };

  // First run: from beginning
  const step1 = await emitAntigravityUsage(
    transcript,
    "session-123",
    "gemini-2.5-flash",
    undefined,
    undefined,
    {},
    emitFn,
  );
  assert.equal(step1, 2);
  assert.equal(emitted.length, 2);
  const first = emitted[0];
  assert.ok(first);
  assert.equal(first.event, "api_request");
  assert.equal(first.usage_schema, "guard.usage.v1");
  assert.equal(first.harness, "antigravity");
  assert.ok(!("harness_legacy" in first));
  assert.equal(first["session.id"], "session-123");
  assert.equal(first.model, "gemini-2.5-flash");
  assert.equal(first.provider, "google");
  assert.equal(first.input_tokens, 1000);
  assert.equal(first.output_tokens, 200);
  assert.equal(first.cache_read_tokens, 100);
  assert.ok(!("cost_usd" in first));
  assert.ok(!("cost_source" in first));
  assert.ok(!("cache_creation_tokens" in first));
  assert.ok(!("reasoning_tokens" in first));
  const second = emitted[1];
  assert.ok(second);
  assert.equal(second.cache_read_tokens, 0);
  assert.ok(!("cost_usd" in second));
  assert.ok(!("cost_source" in second));

  // Second run with lastStep=2: nothing new emitted
  emitted.length = 0;
  const step2 = await emitAntigravityUsage(
    transcript,
    "session-123",
    "gemini-2.5-flash",
    2,
    undefined,
    {},
    emitFn,
  );
  assert.equal(step2, 2);
  assert.equal(emitted.length, 0);

  // Append step 3
  appendFileSync(
    transcript,
    JSON.stringify({
      step_index: 3,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      input_tokens: 500,
      output_tokens: 50,
    }) + "\n",
  );
  const step3 = await emitAntigravityUsage(
    transcript,
    "session-123",
    "gemini-2.5-flash",
    2,
    undefined,
    {},
    emitFn,
  );
  assert.equal(step3, 3);
  assert.equal(emitted.length, 1);
  const third = emitted[0];
  assert.ok(third);
  assert.equal(third.input_tokens, 500);
  assert.equal(third.output_tokens, 50);
  assert.ok(!("cache_read_tokens" in third));
  assert.ok(!("cache_creation_tokens" in third));
  assert.ok(!("reasoning_tokens" in third));
  assert.ok(!("cost_usd" in third));
  assert.ok(!("cost_source" in third));

  rmSync(transcript, { force: true });
});

void test("emitAntigravityUsage: enriches from the observed workspace and does not infer a missing cwd", async () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-antigravity-repo-"));
  const transcript = join(dir, "transcript.jsonl");
  const workspace = join(dir, "workspace");
  mkdirSync(workspace);
  execFileSync("git", ["init", "-q", workspace]);
  execFileSync("git", [
    "-C",
    workspace,
    "remote",
    "add",
    "origin",
    "https://example.com/acme/observed.git",
  ]);
  writeFileSync(
    transcript,
    `${JSON.stringify({
      step_index: 1,
      type: "PLANNER_RESPONSE",
      input_tokens: 1,
      output_tokens: 2,
      cache_read_tokens: 3,
    })}\n`,
  );
  const env = {
    GUARD_OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.invalid",
  };
  const observed: Record<string, unknown>[] = [];
  const absent: Record<string, unknown>[] = [];
  try {
    await emitAntigravityUsage(
      transcript,
      "conversation-observed",
      "gemini-2.5-flash",
      undefined,
      workspace,
      env,
      async (_event, attrs) => {
        observed.push(attrs);
        await Promise.resolve();
      },
    );
    await emitAntigravityUsage(
      transcript,
      "conversation-absent",
      "gemini-2.5-flash",
      undefined,
      undefined,
      env,
      async (_event, attrs) => {
        absent.push(attrs);
        await Promise.resolve();
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(observed[0]?.repo, "acme/observed");
  assert.equal("repo" in (absent[0] ?? {}), false);
});

void test("emitAntigravityUsage: preserves observed tokens without guessing a missing model or cost", async () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-antigravity-usage-"));
  const transcript = join(dir, "transcript.jsonl");
  writeFileSync(
    transcript,
    `${JSON.stringify({
      step_index: 1,
      type: "PLANNER_RESPONSE",
      input_tokens: 123,
      output_tokens: 45,
      cache_read_tokens: 6,
    })}\n`,
  );
  const emitted: Record<string, unknown>[] = [];
  try {
    await emitAntigravityUsage(
      transcript,
      "conversation-1",
      undefined,
      undefined,
      undefined,
      {},
      async (_event, attrs) => {
        emitted.push(attrs);
        await Promise.resolve();
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(emitted, [
    {
      usage_schema: "guard.usage.v1",
      "session.id": "conversation-1",
      provider: "google",
      input_tokens: 123,
      output_tokens: 45,
      cache_read_tokens: 6,
      harness: "antigravity",
    },
  ]);
});

void test("appendDecision: one line to GUARD_RUN_EVENTS_FILE, nothing when it is blank or unset, no legacy variable", () => {
  const written: [string, string][] = [];
  const append = (file: string, data: string): void => {
    written.push([file, data]);
  };
  const now = new Date("2026-01-02T03:04:05.000Z");
  appendDecision(
    { GUARD_RUN_EVENTS_FILE: "/run/events.jsonl" },
    { decision: "deny", rule: "run-label", cmd_hash: "abc" },
    now,
    append,
  );
  assert.deepEqual(written, [
    [
      "/run/events.jsonl",
      '{"ts":"2026-01-02T03:04:05.000Z","decision":"deny","rule":"run-label","cmd_hash":"abc"}\n',
    ],
  ]);
  for (const env of [
    undefined,
    {},
    { GUARD_RUN_EVENTS_FILE: "" },
    { GUARD_RUN_EVENTS_FILE: "  " },
    { FACTORY_EVENTS_FILE: "/legacy.jsonl" },
  ])
    appendDecision(env, { decision: "deny", rule: "x" }, now, append);
  assert.equal(written.length, 1);
  assert.doesNotThrow(() => {
    appendDecision(
      { GUARD_RUN_EVENTS_FILE: "/x" },
      { decision: "deny" },
      now,
      () => {
        throw new Error("unwritable");
      },
    );
  });
});
