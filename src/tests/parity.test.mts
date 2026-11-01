import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deliveries,
  gaps,
  HARNESSES,
  inventory,
  tierGaps,
  tiers,
  type AgentTierDef,
  type Deliveries,
  type Inventory,
} from "../scripts/parity.mjs";

const all = (skills: string[], agents: string[]): Deliveries =>
  Object.fromEntries(
    HARNESSES.map((h) => [
      h,
      { skills: new Set(skills), agents: new Set(agents) },
    ]),
  ) as Deliveries;

const inv: Inventory = {
  skills: [
    { plugin: "dev-tools", name: "ship" },
    { plugin: "python", name: "python-testing" },
  ],
  agents: [{ plugin: "dev-tools", name: "scout" }],
};

void test("this repo: every skill and agent reaches every harness", () => {
  const found = inventory();
  assert.ok(
    found.skills.some((s) => s.name === "ship") &&
      found.agents.some((a) => a.name === "scout"),
  );
  assert.deepEqual(gaps(found, deliveries()), []);
});

void test("a full delivery has no gaps", () => {
  assert.deepEqual(gaps(inv, all(["ship", "python-testing"], ["scout"])), []);
});

void test("a skill one harness misses is reported for that harness only", () => {
  const d = all(["ship", "python-testing"], ["scout"]);
  d.opencode.skills.delete("python-testing");
  assert.deepEqual(gaps(inv, d), [
    "skill python:python-testing: not delivered to opencode",
  ]);
});

void test("an agent one harness misses is reported", () => {
  const d = all(["ship", "python-testing"], ["scout"]);
  d.pi.agents.clear();
  assert.deepEqual(gaps(inv, d), [
    "agent dev-tools:scout: not delivered to pi",
  ]);
});

void test("a harness with no delivery at all reports everything", () => {
  const d: Partial<Deliveries> = all(["ship", "python-testing"], ["scout"]);
  delete d.codex;
  assert.equal(gaps(inv, d).filter((g) => g.endsWith("to codex")).length, 3);
});

void test("the same skill name in two plugins is reported: opencode and pi flatten skills by name", () => {
  const dup: Inventory = {
    skills: [...inv.skills, { plugin: "api", name: "ship" }],
    agents: [],
  };
  const firstGap = gaps(dup, all(["ship", "python-testing"], []))[0] ?? "";
  assert.match(firstGap, /skill ship: in both dev-tools and api/);
});

const def = (over: Partial<AgentTierDef> = {}): AgentTierDef => ({
  plugin: "api",
  name: "api-reviewer",
  claude: { model: "opus", effort: "medium" },
  codex: { effort: "medium" },
  copilot: {},
  opencode: {},
  antigravity: {},
  ...over,
});

void test("this repo: every agent runs at one tier on every harness", () => {
  assert.deepEqual(tierGaps(tiers(inventory())), []);
});

void test("a model pinned outside Claude is a tier mismatch", () => {
  assert.deepEqual(tierGaps([def({ copilot: { model: "sonnet" } })]), [
    "agent api:api-reviewer: copilot pins model sonnet; leave it to the session so the tier matches Claude's opus",
  ]);
});

void test("Claude and Codex effort must agree", () => {
  assert.deepEqual(tierGaps([def()]), []);
  assert.deepEqual(tierGaps([def({ codex: {} })]), [
    "agent api:api-reviewer: effort medium in Claude but unset in Codex",
  ]);
});
