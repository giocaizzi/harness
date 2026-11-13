// Regression corpus: real commands (paraphrased, hosts and paths anonymised) from the guard reviews, each with the
// decision the guard must reach. Rows of an open bug run as `todo`, so the suite stays green while the fix is pending;
// the PR that fixes a bug drops its id from OPEN. Every new false ask or missed command found in telemetry or
// transcripts becomes a row here.
// Row: [command, expected ('allow' | 'allow:<hint>' | 'ask:<rule>' | 'deny:<rule>'), bug id, source, options?]
// options: { leak: true } gitleaks finds a planted key in the commits a push sends; { squashed: true } the branch or worktree is a squash-merged worker's; { pr: 'open' | 'closed-3d' } the remote branch's PR state.
// options: { python: 'uv' } the repo's Python manager; { hints: true } the read and edit hints not yet shown;
// { read: false } the command must not get the plain-read allow (`pureRead`), so the harness's own prompt decides.
// { run: 'registered' | 'configured' | 'unsure' | 'protected' } a registered unattended run: example labels and protected paths, other label names (for 'configured'), a registration that requires labels but names none, or one protecting only a label.
// { branch: 'main' } the current branch the fake git reports for a bare lease push (default 'feat/x'; null: unreadable).
// { stack: <facts> } the stacked-PR facts `stackFacts` gathered: { below: { number, branch }, base }, or {} for none.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { branchFacts, evaluateCommand, pureRead, pushFacts, pushScanFacts, refFacts, regenFacts, remoteDeleteFacts, worktreeFacts, } from "./engine.mjs";
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
    "github-pull-requests",
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
    if (argv[0] === "gh" && argv.includes("--state") && argv.includes("all"))
        return '[{"number":1,"state":"MERGED","headRefOid":"abc123"}]';
    if (argv[0] === "gh" && argv.includes("--base") && argv.includes("open"))
        return "";
    if (argv[0] === "gh")
        return "abc123\n";
    if (argv.includes("ls-remote"))
        return "abc123\trefs/heads/x\n";
    return null;
};
const DAY = 86_400_000;
// A squash-merged worker branch: two commits on no remote ref, no PR of its own name, a merged PR into main holds the
// tip. Its worktree is clean.
const squashedRun = (argv) => {
    if (argv.includes("rev-list"))
        return "2\n";
    if (argv.includes("--git-dir"))
        return "/Users/me/repo/.git/worktrees/w\n/Users/me/repo/.git\n\n/Users/me/repo/w\n";
    if (argv.includes("status") || argv.includes("ls-files"))
        return "";
    if (argv.includes("--show-current"))
        return "worker/u1\n";
    if (argv.includes("--verify"))
        return "abc123\n";
    if (argv.includes("--show-toplevel"))
        return "/Users/me/repo\n";
    if (argv.includes("symbolic-ref"))
        return "origin/main\n";
    if (argv.includes("cat-file") || argv.includes("merge-base"))
        return "";
    if (argv[0] === "gh" && argv.includes("--search"))
        return "abc123\n";
    if (argv[0] === "gh")
        return "";
    return null;
};
// A branch with a PR: open, or closed three days ago with its last push then.
const prRun = (state) => (argv) => {
    if (argv[0] === "gh" && argv.includes("--head") && argv.includes("all")) {
        const at = new Date(Date.now() - 3 * DAY).toISOString();
        return JSON.stringify([
            state === "open"
                ? { number: 4, state: "OPEN", headRefOid: "abc123" }
                : {
                    number: 4,
                    state: "CLOSED",
                    headRefOid: "abc123",
                    closedAt: at,
                    pushed: at,
                },
        ]);
    }
    return run(argv);
};
// A push whose new commits the scan reads: one commit ahead of the upstream, and gitleaks finds a planted key or not.
const pushScanRun = (leak) => (argv) => {
    if (argv.includes("@{u}"))
        return "origin/feat/x\n";
    if (argv.includes("rev-list"))
        return "1\n";
    if (argv[0] === "gitleaks")
        return leak
            ? '[{"RuleID":"aws-access-token","File":"app.env","StartLine":3,"Commit":"1234567890abcdef"}]'
            : "[]";
    return null;
};
const PROTECT = {
    root: "/Users/me/repo",
    cwd: "/Users/me/repo",
};
const RUN = {
    registered: {
        labels: { approval: "agent-ok", takeover: "factory-takeover" },
        protect: {
            ...PROTECT,
            registered: [".factory/**"],
            exempt: [".factory/runs/*/*/**"],
        },
    },
    configured: {
        labels: {
            approval: "go-ahead",
            takeover: "hand-over",
            protected: ["agent-ok", "factory-takeover"],
        },
        protect: {
            ...PROTECT,
            registered: [".factory/**"],
            exempt: [".factory/runs/*/*/**"],
        },
    },
    protected: { labels: { protected: ["acme-parked"] }, protect: PROTECT },
    unsure: { unsure: true },
};
const decide = async (command, { branch = "feat/x", python = null, hints = false, run: runOption = null, stack = null, leak, squashed, pr, } = {}) => {
    const base = squashed ? squashedRun : pr ? prRun(pr) : run;
    // The current branch the fake git reports for a bare lease push (`branch`, a feature branch unless a row says so).
    const pushRun = (argv) => argv.includes("--abbrev-ref") && argv.includes("HEAD")
        ? branch === null
            ? null
            : `${branch}\n`
        : base(argv);
    const [worktrees, branches, regenerable, refs, pushes, remoteDeletes] = await Promise.all([
        worktreeFacts(command, env, rules, base),
        branchFacts(command, rules, base, env),
        regenFacts(command, env, rules, base),
        refFacts(command, rules, base, env),
        pushFacts(command, rules, pushRun, env),
        remoteDeleteFacts(command, rules, base, env),
    ]);
    const pushScan = await pushScanFacts(command, rules, pushScanRun(leak === true), env);
    const state = { reminded: new Set(hints ? [] : ["read", "edit"]) };
    const d = evaluateCommand({
        command,
        loadedSkills,
        state,
        env,
        worktrees,
        branches,
        pushes,
        regenerable,
        refs,
        remoteDeletes,
        pushScan,
        python,
        stack,
        run: runOption ? RUN[runOption] : null,
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
        (value.branch === undefined ||
            value.branch === null ||
            typeof value.branch === "string") &&
        (value.python === undefined ||
            value.python === null ||
            typeof value.python === "string") &&
        (value.hints === undefined || typeof value.hints === "boolean") &&
        (value.read === undefined || typeof value.read === "boolean") &&
        (value.leak === undefined || typeof value.leak === "boolean") &&
        (value.squashed === undefined || typeof value.squashed === "boolean") &&
        (value.pr === undefined ||
            value.pr === "open" ||
            value.pr === "closed-3d") &&
        (value.run === undefined ||
            value.run === null ||
            value.run === "registered" ||
            value.run === "configured" ||
            value.run === "protected" ||
            value.run === "unsure") &&
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
