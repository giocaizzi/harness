function defined(value) {
    if (value === undefined || value === null)
        throw new Error("Missing expected value");
    return value;
}
// The stacked-PR hint: which `gh pr create|merge` units the engine reads, the facts it gathers through an injected
// runner, and the once-per-agent hint evaluateCommand returns.
import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateCommand, stackEarlyFacts, stackEarlyTargets, stackFacts, stackTargets, } from "./engine.mjs";
import { rules } from "./rules.mjs";
const env = { HOME: "/Users/me", dirs: { has: () => true } };
void test("stackTargets reads create and merge units: base, operand, repo, cd", () => {
    const t = (c) => stackTargets(c, rules, env);
    assert.deepEqual(t("gh pr create --fill"), [
        { verb: "create", dir: "", base: null, pr: null, repo: null, head: null },
    ]);
    assert.equal(defined(t('gh pr create --base feat/a --title "x y" --fill')[0]).base, "feat/a");
    assert.equal(defined(t("gh pr create --base=feat/a --fill")[0]).base, "feat/a");
    assert.equal(defined(t("gh pr create --title main --fill")[0]).base, null);
    const m = t("gh pr merge 12 --auto --squash -R acme/app")[0];
    assert.deepEqual([defined(m).verb, defined(m).pr, defined(m).repo, defined(m).base], ["merge", "12", "acme/app", null]);
    assert.equal(defined(t("cd /work/app && gh pr create --fill")[0]).dir, "/work/app");
    assert.deepEqual(t("gh pr view 12"), []);
    assert.deepEqual(t("echo gh pr create"), []);
});
// A repo where `feat/b` (HEAD) is built on `feat/a` (#7), which is not in main; `feat/old` (#5) is merged into main.
const fake = ({ def = "origin/main\n", onTop = ["feat/a", "feat/old"], inDefault = ["feat/old"], open = [
    { number: 7, headRefName: "feat/a" },
    { number: 5, headRefName: "feat/old" },
    { number: 9, headRefName: "feat/b" },
], pr = { headRefName: "feat/b", baseRefName: "main" }, fail = null, } = {}) => {
    const calls = [];
    const run = (argv) => {
        const a = argv.join(" ");
        calls.push(a);
        if (fail && a.includes(fail))
            return null;
        if (argv[1] === "symbolic-ref")
            return def;
        if (argv[1] === "rev-parse")
            return "feat/b\n";
        if (argv[0] === "gh" && argv[1] === "repo")
            return "main\n";
        if (argv[0] === "gh" && argv[2] === "view")
            return JSON.stringify(pr);
        if (argv[0] === "gh" && argv[2] === "list")
            return JSON.stringify(open);
        if (argv[1] === "merge-base") {
            const other = defined(argv[3]).replace("origin/", "");
            return (argv[4] === "origin/main" ? inDefault : onTop).includes(other)
                ? ""
                : null;
        }
        throw new Error(`unexpected ${a}`);
    };
    return { run, calls };
};
void test("stackTargets parses value flags per verb, attached values included", () => {
    const t = (c) => stackTargets(c, rules, env)[0];
    assert.equal(defined(t("gh pr merge -m 12")).pr, "12");
    assert.equal(defined(t("gh pr merge -r 12")).pr, "12");
    assert.equal(defined(t("gh pr merge -s -d 12")).pr, "12");
    assert.equal(defined(t("gh pr merge -t subj 12")).pr, "12");
    assert.equal(defined(t("gh pr merge --match-head-commit abc 12")).pr, "12");
    assert.equal(defined(t("gh pr create -Racme/app --fill")).repo, "acme/app");
    assert.equal(defined(t("gh pr create -Bfeat/a --fill")).base, "feat/a");
    assert.equal(defined(t("gh pr create -m ms -T tpl -p proj --fill")).base, null);
    assert.equal(defined(t("gh pr create --head feat/x --fill")).head, "feat/x");
    assert.equal(defined(t("gh pr create -H feat/x --fill")).head, "feat/x");
});
void test("stackFacts: a repo starting with a dash, or a create with --head, gives {} without a lookup", async () => {
    const { run, calls } = fake();
    assert.deepEqual(await stackFacts("gh pr create -R -wb/x --fill", rules, run, env), {});
    assert.deepEqual(await stackFacts("gh pr create --head feat/x --fill", rules, run, env), {});
    assert.deepEqual(await stackFacts("gh pr create -H feat/x --fill", rules, run, env), {});
    assert.deepEqual(calls, []);
});
void test("stackFacts: a create that builds on an open PR not in the default branch gives the PR below", async () => {
    const { run, calls } = fake();
    assert.deepEqual(await stackFacts("gh pr create --fill", rules, run, env), {
        below: { number: 7, branch: "feat/a" },
        base: "main",
        verb: "create",
        head: "feat/b",
    });
    assert.ok(calls.includes("git merge-base --is-ancestor origin/feat/a HEAD"));
    assert.ok(!calls.some((c) => c.includes("origin/feat/b ")), "the head itself is skipped");
});
void test("stackFacts: a merge reads head and base from the PR and tests origin/<head>", async () => {
    const { run, calls } = fake();
    assert.equal(defined((await stackFacts("gh pr merge 9 --squash", rules, run, env)).below)
        .number, 7);
    assert.ok(calls.includes("git merge-base --is-ancestor origin/feat/a origin/feat/b"));
    assert.ok(calls.some((c) => c.startsWith("gh pr view 9 --json headRefName,baseRefName")));
});
void test("stackFacts: falls back to gh for the default branch", async () => {
    const { run } = fake({ fail: "symbolic-ref" });
    assert.equal((await stackFacts("gh pr create --fill", rules, run, env)).base, "main");
});
void test("stackFacts: already stacked, another base, or nothing below gives {}", async () => {
    assert.deepEqual(await stackFacts("gh pr create --base feat/a --fill", rules, fake().run, env), {});
    assert.deepEqual(await stackFacts("gh pr merge 9", rules, fake({ pr: { headRefName: "feat/b", baseRefName: "feat/a" } }).run, env), {});
    assert.deepEqual(await stackFacts("gh pr create --fill", rules, fake({ inDefault: ["feat/old", "feat/a"] }).run, env), {});
    assert.deepEqual(await stackFacts("gh pr create --fill", rules, fake({ onTop: [] }).run, env), {});
});
void test("stackFacts: failures and odd names give {}", async () => {
    for (const fail of ["rev-parse", "pr list", "gh repo"]) {
        assert.deepEqual(await stackFacts("gh pr create --fill", rules, fake({ fail, def: null }).run, env), {}, fail);
    }
    assert.deepEqual(await stackFacts("gh pr create --fill", rules, () => {
        throw new Error("boom");
    }, env), {});
    assert.deepEqual(await stackFacts("gh pr create --fill", rules, fake({ open: [{ number: 7, headRefName: "a;rm -rf x" }] }).run, env), {});
    assert.deepEqual(await stackFacts('gh pr create --base "$B" --fill', rules, fake().run, env), {});
    assert.deepEqual(await stackFacts("gh pr list", rules, fake().run, env), {});
});
const below = {
    below: { number: 7, branch: "feat/a" },
    base: "main",
    head: "feat/b",
    verb: "create",
};
const mergeBelow = { ...below, verb: "merge" };
const skills = ["pr", "ship", "github-pull-requests", "conventional-commits"];
const decide = (command, state, stack = below, loaded = skills) => evaluateCommand({
    command,
    state,
    env,
    stack,
    loadedSkills: new Set(loaded),
    rules,
});
void test("stackFacts: carries the verb and the head", async () => {
    const f = await stackFacts("gh pr create --fill", rules, fake().run, env);
    assert.deepEqual([f.verb, f.head], ["create", "feat/b"]);
    const m = await stackFacts("gh pr merge 9", rules, fake().run, env);
    assert.equal(m.verb, "merge");
});
void test("evaluateCommand: a create to the default branch carrying an open PR is denied every time", () => {
    const state = { reminded: new Set() };
    for (let i = 0; i < 2; i++) {
        const d = decide("gh pr create --fill", state);
        assert.deepEqual([d.action, d.rule], ["deny", "stack"]);
        assert.match(defined(d.reason), /open PR #7 \(`feat\/a`\) but this PR targets `main`.*plus `--base feat\/a`.*`gh stack link feat\/a feat\/b`.*needs no Split-Reason/);
    }
    assert.ok(!state.reminded.has("stack"));
    assert.deepEqual(decide("gh pr create --fill", { reminded: new Set() }, {}), { action: "allow" });
});
void test("evaluateCommand: a merge gets the hint, once", () => {
    const state = { reminded: new Set() };
    const d = decide("gh pr merge 9 --squash", state, mergeBelow);
    assert.deepEqual([d.action, d.rule, d.remind], ["allow", "stack", true]);
    assert.match(defined(d.context), /#7 \(`feat\/a`\).*targets `main`/);
    assert.match(defined(d.context), /gh stack init.*Stacks without `gh stack`/);
    assert.ok(state.reminded.has("stack"));
    assert.deepEqual(decide("gh pr merge 9 --squash", state, mergeBelow), {
        action: "allow",
    });
});
void test("evaluateCommand: the stack deny wins over a pr-batch deny", () => {
    const d = evaluateCommand({
        command: "gh pr create --fill",
        state: { reminded: new Set() },
        env,
        stack: below,
        prBatch: {
            "": {
                reason: { kind: "none" },
                overlaps: [{ files: ["src/a.ts"], head: "feat/a", number: 7 }],
            },
        },
        loadedSkills: new Set(skills),
        rules,
    });
    assert.deepEqual([d.action, d.rule], ["deny", "stack"]);
});
void test("evaluateCommand: a deny, an ask or a skill deny wins over the merge hint", () => {
    const state = { reminded: new Set() };
    assert.equal(decide('gh pr create --title "bad title"', state, {}).rule, "title");
    assert.equal(decide("gh pr merge 9 && rm -rf src", state, mergeBelow).action, "ask");
    const skill = decide("gh pr merge 9", state, mergeBelow, []);
    assert.equal(skill.action, "deny");
    assert.ok(!state.reminded.has("stack"));
});
const early = ({ upstream = null, current = "feat/b", fail, } = {}) => {
    const calls = [];
    const run = (argv) => {
        const a = argv.join(" ");
        calls.push(a);
        if (fail && a.includes(fail))
            return null;
        if (argv[1] === "symbolic-ref")
            return "origin/main\n";
        if (a === "git rev-parse --abbrev-ref HEAD")
            return `${current}\n`;
        if (a.includes("@{u}"))
            return upstream;
        if (argv[0] === "gh" && argv[2] === "list")
            return JSON.stringify([{ number: 7, headRefName: "feat/a" }]);
        if (argv[1] === "merge-base")
            return argv[4] === "origin/main" ? null : "";
        throw new Error(`unexpected ${a}`);
    };
    return { run, calls };
};
void test("stackEarlyTargets: new-branch and push forms, nothing else", () => {
    const t = (c) => stackEarlyTargets(c, env)[0];
    for (const c of [
        "git switch -c feat/n feat/a",
        "git switch -C feat/n feat/a",
        "git checkout -b feat/n feat/a",
        "git checkout -B feat/n feat/a",
        "git branch feat/n feat/a",
        "git worktree add -b feat/n ../w feat/a",
        "git worktree add ../w -B feat/n feat/a",
    ])
        assert.deepEqual([t(c)?.kind, t(c)?.name, t(c)?.start], ["branch", "feat/n", "feat/a"], c);
    assert.equal(t("git switch -c feat/n")?.start, null);
    assert.equal(t("git push -u origin feat/b")?.kind, "push");
    assert.equal(t("git push")?.kind, "push");
    for (const c of [
        "git branch -d x",
        "git branch -m a b",
        "git branch --list",
        "git branch",
        "git checkout feat/a",
        "git switch feat/a",
        "git worktree add ../w feat/a",
        "git push --all",
        "git push --tags",
        "git push origin --delete x",
        "git push --mirror",
        "git status",
        "echo git push",
    ])
        assert.deepEqual(stackEarlyTargets(c, env), [], c);
});
void test("stackEarlyFacts: a branch from an open PR's head gives the hint facts, once per branch", async () => {
    const { run } = early();
    const f = await stackEarlyFacts("git switch -c feat/n origin/feat/a", run, env);
    assert.deepEqual(f, {
        base: "main",
        below: { number: 7, branch: "feat/a" },
        branch: "feat/n",
        key: "stack-branch:feat/n",
        kind: "branch",
        start: "feat/a",
    });
    const cur = await stackEarlyFacts("git checkout -b feat/n", run, env);
    assert.equal(cur, null, "the current branch feat/b has no open PR");
});
void test("stackEarlyFacts: default branch, a sha, an unknown start, a spent key and no match cost nothing or give null", async () => {
    const w = early();
    const f = (c, spent) => stackEarlyFacts(c, w.run, env, spent);
    assert.equal(await f("git switch -c feat/n main"), null);
    assert.equal(await f("git switch -c feat/n origin/main"), null);
    assert.equal(await f("git switch -c feat/n abc1234"), null);
    assert.equal(await f("git switch -c feat/n feat/zzz"), null);
    const n = w.calls.length;
    assert.equal(await f("git switch -c feat/n feat/a", (k) => k === "stack-branch:feat/n"), null);
    assert.equal(await f("git status"), null);
    assert.equal(w.calls.length, n, "no lookups");
    for (const fail of ["symbolic-ref", "gh pr list"])
        assert.equal(await stackEarlyFacts("git switch -c feat/n feat/a", early({ fail }).run, env), null, fail);
    assert.equal(await stackEarlyFacts("git switch -c feat/n feat/a", () => {
        throw new Error("boom");
    }, env), null);
});
void test("stackEarlyFacts: a first push of a branch that carries an open PR; not with an upstream, another ref or the default branch", async () => {
    const f = (c, world) => stackEarlyFacts(c, early(world).run, env);
    const hit = await f("git push -u origin feat/b");
    assert.deepEqual([hit?.kind, hit?.key, hit?.below.number, hit?.branch], ["push", "stack-push:feat/b", 7, "feat/b"]);
    assert.equal((await f("git push"))?.kind, "push");
    assert.equal(await f("git push", { upstream: "origin/feat/b\n" }), null);
    assert.equal(await f("git push origin other"), null);
    assert.equal((await f("git push origin HEAD"))?.kind, "push");
    assert.equal(await f("git push", { current: "main" }), null);
    assert.equal(await f("git push", { fail: "merge-base" }), null);
    assert.equal(await f("git push", { fail: "gh pr list" }), null);
});
const advise = (command, state, e) => evaluateCommand({
    command,
    state,
    env,
    early: e,
    loadedSkills: new Set([...skills, "wt"]),
    rules,
});
void test("evaluateCommand: the early hints are once per key, remind, and never deny", async () => {
    const state = { reminded: new Set() };
    const b = await stackEarlyFacts("git switch -c feat/n feat/a", early().run, env);
    const d = advise("git switch -c feat/n feat/a", state, b);
    assert.deepEqual([d.action, d.rule, d.remind], ["allow", "stack-branch", true]);
    assert.match(defined(d.context), /^Stack hint: `feat\/n` starts from your open PR #7 \(`feat\/a`\).*gh pr create --base feat\/a.*origin\/main/);
    assert.deepEqual(advise("git switch -c feat/n feat/a", state, b), {
        action: "allow",
    });
    const p = await stackEarlyFacts("git push -u origin feat/b", early().run, env);
    const e = advise("git push -u origin feat/b", state, p);
    assert.equal(e.rule, "stack-push");
    assert.match(defined(e.context), /^Stack hint: this branch carries the commits of your open PR #7 \(`feat\/a`\).*gh stack link feat\/a feat\/b.*against `main` will be denied/);
    assert.equal(advise("git push -u origin feat/b", state, p).rule, undefined);
});
