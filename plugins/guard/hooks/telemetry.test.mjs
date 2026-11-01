import assert from "node:assert/strict";
import { test } from "node:test";
import { commandHash, failedTarget, guardVersion, harnessName, recordAttrs, repoName, repoSlug, scrub, } from "./telemetry.mjs";
void test("harnessName: the --harness flag wins, then the data dir each harness sets", () => {
    assert.equal(harnessName(["node", "stop.mjs", "--harness=codex"], {
        CLAUDE_PLUGIN_DATA: "/d",
    }), "codex");
    assert.equal(harnessName([], {
        CLAUDE_PLUGIN_DATA: "/d",
        CLAUDE_PLUGIN_ROOT: "/r",
    }), "claude");
    assert.equal(harnessName([], { COPILOT_PLUGIN_DATA: "/d" }), "copilot");
    assert.equal(harnessName([], { CLAUDE_PLUGIN_ROOT: "/r" }), "vscode");
    assert.equal(harnessName([], {}), "other");
});
void test("recordAttrs: harness, guard version and repo only when a record will be sent", () => {
    assert.deepEqual(recordAttrs({ a: 1 }, "/", "claude", {}), { a: 1 });
    assert.deepEqual(recordAttrs({ a: 1 }, "/", "claude", {
        GUARD_OTEL_EXPORTER_OTLP_ENDPOINT: "http://c",
        GUARD_OTEL: "off",
    }), { a: 1 });
    const r = recordAttrs({ a: 1 }, "/", "claude", {
        GUARD_OTEL_EXPORTER_OTLP_ENDPOINT: "http://c",
    });
    assert.equal(r.harness, "claude");
    assert.equal(r.guard_version, guardVersion());
    assert.match(String(r.guard_version), /^\d+\.\d+\.\d+$/);
});
void test("repoName: owner/name of the origin remote, else the first remote, once per directory; null outside git", () => {
    let calls = 0;
    const run = (_, args) => {
        calls++;
        return args.join(" ") === "remote get-url origin"
            ? "git@github.com:acme/widgets.git\n"
            : "";
    };
    assert.equal(repoName("/x/y", run), "acme/widgets");
    assert.equal(repoName("/x/y", run), "acme/widgets");
    assert.equal(calls, 1);
    const noOrigin = (_, args) => {
        if (args[2] === "origin")
            throw new Error("no origin");
        return args[0] === "remote" && args.length === 1
            ? "upstream\n"
            : "https://token@example.com/acme/tools\n";
    };
    assert.equal(repoName("/z", noOrigin), "acme/tools");
    assert.equal(repoName("/nowhere", () => {
        throw new Error("not a repo");
    }), null);
});
void test("repoSlug: owner/name only, never host, user or token", () => {
    assert.equal(repoSlug("https://github.com/acme/widgets.git"), "acme/widgets");
    assert.equal(repoSlug("https://x-access-token:abc@github.com/acme/widgets"), "acme/widgets");
    assert.equal(repoSlug("git@github.com:acme/widgets.git"), "acme/widgets");
    assert.equal(repoSlug("ssh://git@host:22/acme/widgets/"), "acme/widgets");
    assert.equal(repoSlug("https://dev.azure.com/org/proj/_git/widgets"), "proj/widgets");
    assert.equal(repoSlug("https://gitlab.com/group/sub/widgets.git"), "sub/widgets");
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
    assert.equal(failedTarget("ok\nmake[1]: *** [Makefile:12: test] Error 1\nmake: *** [check] Error 2"), "test");
    assert.equal(failedTarget("make: *** [lint] Error 2"), "lint");
    assert.equal(failedTarget("nothing"), null);
});
void test("commandHash: whitespace does not change it, the command text never shows", () => {
    assert.equal(commandHash("rm  -rf   x"), commandHash(" rm -rf x "));
    assert.match(commandHash("rm -rf x"), /^[0-9a-f]{12}$/);
});
