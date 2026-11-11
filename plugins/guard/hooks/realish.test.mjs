import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { test } from "node:test";
import { evaluateCommand, pushScanFacts } from "../core/engine.mjs";
import { rules } from "../core/rules.mjs";
import { readingsOf, realish } from "./guard.mjs";
// A Windows tree of links (lowercase, `\` paths); every other path is a plain directory or missing.
const links = {
    "c:\\r\\d": "C:\\other",
    "c:\\r\\n": "d\\..\\z",
};
const env = {
    platform: "win32",
    path: win32,
    isLink: (p) => p.toLowerCase() in links,
    readLink: (p) => links[p.toLowerCase()] ?? "",
};
void test("realish: win32 reads backslash paths and follows a link before a later `..`", () => {
    assert.equal(realish("C:\\r\\d\\..\\x", false, env), "C:/x");
    assert.equal(realish("C:\\r\\q/y", false, env), "C:/r/q/y");
});
void test("realish: win32 lexical reading normalises a relative link target as text", () => {
    // raw: n -> d\..\z follows d (-> C:\other) before `..`, giving C:\z; lexical: C:\r\z.
    assert.equal(realish("C:\\r\\n", false, env), "C:/z");
    assert.equal(realish("C:\\r\\n", true, env), "C:/r/z");
});
void test("realish: a link loop returns null", () => {
    const loop = {
        ...env,
        isLink: () => true,
        readLink: () => "a",
    };
    assert.equal(realish("C:\\a", false, loop), null);
});
void test("readingsOf: the lexical win32 readings are added on win32 only (the platform comes from the env)", () => {
    const file = { lex: "C:\\r\\n", raw: "C:\\r\\n" };
    // win32: the link followed as the kernel does (C:/z) and its target taken as text (C:/r/z), beside the lexical path
    assert.deepEqual(readingsOf(file, env).sort(), ["C:/r/n", "C:/r/z", "C:/z"]);
    // elsewhere the lexical readings are not tried: a `..` in a link target is followed as the kernel does
    const posix = { ...env, platform: "linux" };
    assert.ok(!readingsOf(file, posix).includes("C:/r/z"));
});
// The real gitleaks against a real clone: the ranges reach it as the engine builds them, and only unpushed commits count.
const haveGitleaks = spawnSync("gitleaks", ["version"]).status === 0;
// Hermetic git: the developer's global config (a core.hooksPath pre-push hook that runs gitleaks) must not
// veto the test's own push, which plants a key on purpose. An empty file stands in for /dev/null (Windows lacks it).
const emptyConfig = join(mkdtempSync(join(tmpdir(), "scan-cfg-")), "gitconfig");
writeFileSync(emptyConfig, "");
const hermeticEnv = () => {
    const clean = {};
    for (const [k, v] of Object.entries(process.env))
        if (!k.startsWith("GIT_CONFIG_"))
            clean[k] = v;
    return { ...clean, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: "1" };
};
const sh = (cwd, ...argv) => {
    const r = spawnSync(argv[0] ?? "", argv.slice(1), {
        cwd,
        encoding: "utf8",
        env: hermeticEnv(),
    });
    assert.equal(r.status, 0, `${argv.join(" ")}: ${r.stderr}`);
    return r.stdout;
};
const realRun = (argv, cwd, ms) => {
    const r = spawnSync(argv[0] ?? "", argv.slice(1), {
        cwd,
        encoding: "utf8",
        timeout: ms,
        env: hermeticEnv(),
    });
    return r.status === 0 ? r.stdout : null;
};
// A key-shaped line, stored reversed so no scanner flags this file.
const planted = Array.from("\nlQ3pZa9v1xzYCifRxPb/GNEDM7K/IMEFntUXrlaJw = yek_ssecca_terces_swa")
    .reverse()
    .join("");
void test("realish: the real gitleaks denies a planted key in an unpushed commit, passes it once pushed, and scans a new branch", { skip: !haveGitleaks }, async () => {
    const root = mkdtempSync(join(tmpdir(), "scan-real-"));
    const origin = join(root, "origin.git");
    const clone = join(root, "clone");
    sh(root, "git", "init", "-q", "--bare", origin);
    sh(root, "git", "clone", "-q", origin, clone);
    for (const kv of ["user.email=a@b.c", "user.name=n"])
        sh(clone, "git", "config", ...kv.split("="));
    writeFileSync(join(clone, "a.txt"), "clean\n");
    sh(clone, "git", "add", ".");
    sh(clone, "git", "commit", "-qm", "chore: clean");
    sh(clone, "git", "push", "-q", "-u", "origin", "HEAD");
    const verdict = async (command) => evaluateCommand({
        command,
        state: { reminded: new Set() },
        host: { load1: 1, freeGb: 100 },
        pushScan: await pushScanFacts(command, rules, realRun, {}),
        rules,
    });
    const push = `git -C ${clone} push`;
    assert.equal((await verdict(push)).action, "allow", "nothing new");
    writeFileSync(join(clone, "app.env"), planted);
    sh(clone, "git", "add", ".");
    sh(clone, "git", "commit", "-qm", "chore: add config");
    const denied = await verdict(push);
    assert.equal(denied.action, "deny");
    assert.match(denied.reason ?? "", /app\.env:1 \(generic-api-key\)/);
    assert.doesNotMatch(denied.reason ?? "", /wJalr/);
    sh(clone, "git", "checkout", "-q", "-b", "feat/new");
    const fresh = await verdict(`git -C ${clone} push -u origin feat/new`);
    assert.equal(fresh.action, "deny", "a new branch scans what origin lacks");
    sh(clone, "git", "push", "-q", "-u", "origin", "feat/new");
    assert.equal((await verdict(push)).action, "allow", "pushed commits pass");
});
void test("realish: the real gitleaks denies a key that only a merge commit's conflict resolution carries", { skip: !haveGitleaks }, async () => {
    const root = mkdtempSync(join(tmpdir(), "scan-merge-"));
    const origin = join(root, "origin.git");
    const clone = join(root, "clone");
    sh(root, "git", "init", "-q", "--bare", origin);
    sh(root, "git", "clone", "-q", origin, clone);
    for (const kv of ["user.email=a@b.c", "user.name=n"])
        sh(clone, "git", "config", ...kv.split("="));
    writeFileSync(join(clone, "a.txt"), "base\n");
    sh(clone, "git", "add", ".");
    sh(clone, "git", "commit", "-qm", "chore: base");
    sh(clone, "git", "push", "-q", "-u", "origin", "HEAD");
    sh(clone, "git", "checkout", "-q", "-b", "side");
    writeFileSync(join(clone, "a.txt"), "side\n");
    sh(clone, "git", "commit", "-qam", "chore: side");
    sh(clone, "git", "checkout", "-q", "-");
    writeFileSync(join(clone, "a.txt"), "main\n");
    sh(clone, "git", "commit", "-qam", "chore: main");
    // the merge conflicts; its resolution is the only place the key lives
    spawnSync("git", ["merge", "side"], { cwd: clone, env: hermeticEnv() });
    writeFileSync(join(clone, "a.txt"), `resolved${planted}\n`);
    sh(clone, "git", "add", ".");
    sh(clone, "git", "commit", "-qm", "chore: merge side");
    const command = `git -C ${clone} push`;
    const d = evaluateCommand({
        command,
        state: { reminded: new Set() },
        host: { load1: 1, freeGb: 100 },
        pushScan: await pushScanFacts(command, rules, realRun, {}),
        rules,
    });
    assert.equal(d.action, "deny");
    assert.match(d.reason ?? "", /(?<![\w/])a\.txt:\d+ \(generic-api-key\)/);
});
void test("realish: `git push --all` scans the branches it sends, not a local stash it never sends", { skip: !haveGitleaks }, async () => {
    const root = mkdtempSync(join(tmpdir(), "scan-all-"));
    const origin = join(root, "origin.git");
    const clone = join(root, "clone");
    sh(root, "git", "init", "-q", "--bare", origin);
    sh(root, "git", "clone", "-q", origin, clone);
    for (const kv of ["user.email=a@b.c", "user.name=n"])
        sh(clone, "git", "config", ...kv.split("="));
    writeFileSync(join(clone, "a.txt"), "clean\n");
    sh(clone, "git", "add", ".");
    sh(clone, "git", "commit", "-qm", "chore: clean");
    sh(clone, "git", "push", "-q", "-u", "origin", "HEAD");
    // the key lives only in a local stash: `git push --all` sends refs/heads/*, never refs/stash
    writeFileSync(join(clone, "app.env"), planted);
    sh(clone, "git", "stash", "push", "-q", "-u");
    for (const command of [
        `git -C ${clone} push --all origin`,
        `git -C ${clone} push --branches origin`,
    ]) {
        const d = evaluateCommand({
            command,
            state: { reminded: new Set() },
            host: { load1: 1, freeGb: 100 },
            pushScan: await pushScanFacts(command, rules, realRun, {}),
            rules,
        });
        assert.notEqual(d.action, "deny", `${command}: ${d.reason ?? ""}`);
    }
});
