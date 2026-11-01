// Regression corpus: real commands (paraphrased, hosts and paths anonymised) from the guard reviews, each with the
// decision the guard must reach. Rows of an open bug run as `todo`, so the suite stays green while the fix is pending;
// the PR that fixes a bug drops its id from OPEN. Every new false ask or missed command found in telemetry or
// transcripts becomes a row here.
// Row: [command, expected ('allow' | 'allow:<hint>' | 'ask:<rule>' | 'deny:<rule>'), bug id, source, options?]
// options: { python: 'uv' } the repo's Python manager; { hints: true } the read and edit hints not yet shown;
// { read: false } the command must not get the plain-read allow (`pureRead`), so the harness's own prompt decides.
// { factory: 'readable' | 'unsure' } a factory run whose config was read, or could not be.
// { stack: <facts> } the stacked-PR facts `stackFacts` gathered: { below: { number, branch }, base }, or {} for none.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { branchFacts, evaluateCommand, pureRead, refFacts, regenFacts, worktreeFacts, } from "./engine.mjs";
import { rules } from "./rules.mjs";
const OPEN = new Set([]);
const parsedCorpus = JSON.parse(readFileSync(new URL("./corpus.json", import.meta.url), "utf8"));
const corpus = readCorpus(parsedCorpus);
// Every directory a `cd` names exists.
const env = {
    TMPDIR: "/var/folders/ab/xyz/T/",
    HOME: "/Users/me",
    dirs: { has: () => true },
};
const loadedSkills = new Set([
    "conventional-commits",
    "github-workflow",
    "wt",
    "release-please",
    "docs-sync",
    "python-testing",
    "pr-fix",
]);
// Facts the guard gathers come back favourable, so a row asks only when the guard cannot reach or read them:
// every branch is pushed, every regenerable name is git-ignored, no target is a linked worktree.
const run = (argv) => {
    if (argv.includes("rev-list"))
        return "0\n";
    if (argv.includes("check-ignore"))
        return "";
    if (argv.includes("--show-toplevel") && !argv.includes("--git-dir"))
        return "/Users/me/repo\n";
    // gh: a merged PR whose head is the branch's current tip
    if (argv[0] === "gh")
        return "abc123\n";
    return null;
};
const FACTORY = {
    readable: { approval: "agent-ok", takeover: "factory-takeover" },
    unsure: {
        approval: "agent-ok",
        takeover: "factory-takeover",
        unsure: true,
        extra: [],
    },
};
const decide = async (command, { python = null, hints = false, factory = null, stack = null, } = {}) => {
    const [worktrees, branches, regenerable, refs] = await Promise.all([
        worktreeFacts(command, env, rules, run),
        branchFacts(command, rules, run, env),
        regenFacts(command, env, rules, run),
        refFacts(command, rules, run, env),
    ]);
    const state = { reminded: new Set(hints ? [] : ["read", "edit"]) };
    const d = evaluateCommand({
        command,
        loadedSkills,
        state,
        env,
        worktrees,
        branches,
        regenerable,
        refs,
        python,
        stack,
        factory: factory ? FACTORY[factory] : null,
        rules,
    });
    return (d.action +
        (d.rule && !(d.action === "allow" && !d.remind) ? `:${d.rule}` : ""));
};
for (const [command, expected, bug, source, options] of corpus) {
    void test(`${bug} ${JSON.stringify(command)} -> ${expected} (${source})`, { todo: OPEN.has(bug) && !/^(control|probe)/.test(source) }, async () => {
        assert.equal(await decide(command, options), expected);
        if (options?.read !== undefined)
            assert.equal(pureRead(command), options.read, "plain-read allow");
    });
}
void test("every row names a known bug or a control, and no command repeats", () => {
    const seen = new Set();
    for (const [command, expected, bug] of corpus) {
        assert.match(bug, /^(G\d\d|D\d+|CTRL)$/, command);
        assert.match(expected, /^(allow|ask|deny)(:[\w-]+)?$/, command);
        assert.ok(!seen.has(command), `duplicate row: ${command}`);
        seen.add(command);
    }
});
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isList(value) {
    return Array.isArray(value);
}
function isStack(value) {
    return (isRecord(value) &&
        (value.base === undefined || typeof value.base === "string") &&
        (value.below === undefined ||
            (isRecord(value.below) &&
                typeof value.below.number === "number" &&
                typeof value.below.branch === "string")));
}
function isOptions(value) {
    return (isRecord(value) &&
        (value.python === undefined ||
            value.python === null ||
            typeof value.python === "string") &&
        (value.hints === undefined || typeof value.hints === "boolean") &&
        (value.read === undefined || typeof value.read === "boolean") &&
        (value.factory === undefined ||
            value.factory === null ||
            value.factory === "readable" ||
            value.factory === "unsure") &&
        (value.stack === undefined || value.stack === null || isStack(value.stack)));
}
function readCorpus(value) {
    assert.ok(isList(value));
    return value.map((row) => {
        assert.ok(isList(row));
        const [command, expected, bug, source, options] = row;
        assert.equal(typeof command, "string");
        assert.equal(typeof expected, "string");
        assert.equal(typeof bug, "string");
        assert.equal(typeof source, "string");
        if (typeof command !== "string" ||
            typeof expected !== "string" ||
            typeof bug !== "string" ||
            typeof source !== "string" ||
            (options !== undefined && !isOptions(options)))
            throw new Error("Invalid corpus row");
        return [command, expected, bug, source, options];
    });
}
