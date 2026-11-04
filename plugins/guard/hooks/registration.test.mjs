// Run contract v2 loader. Tests needing POSIX permissions or FIFOs are named `posix registration:` and skip on Windows.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createRegistrationCache, loadRegistration, pinFile, } from "./registration.mjs";
const root = realpathSync(mkdtempSync(join(tmpdir(), "guard-registration-")));
after(() => {
    rmSync(root, { recursive: true, force: true });
});
let n = 0;
const fresh = (name) => {
    const p = join(root, `${String(n++)}-${name}`);
    return p;
};
const MANIFEST = JSON.stringify({
    contract: 2,
    runner: "acme-runner",
    requires: ["result-gate"],
    result: { file: ".acme/runs/{ticket_number}/result.json" },
});
const manifest = (body = MANIFEST, name = "m.json") => {
    const p = fresh(name);
    writeFileSync(p, body);
    return p;
};
const ro = {
    writable: () => false,
    owner: () => false,
    readOnlyMount: () => false,
};
const envFor = (m, extra = {}) => ({
    GUARD_RUN_ID: "r1",
    GUARD_RUN_TICKET: "acme/app#7",
    ...(m === undefined ? {} : { GUARD_RUN_MANIFEST: m }),
    ...extra,
});
const posixOnly = { skip: process.platform === "win32" };
const denyWhy = (r) => {
    assert.equal(r.state, "deny", JSON.stringify(r));
    return r.why;
};
const sha = (s) => createHash("sha256").update(s).digest("hex");
void test("registration: no GUARD_RUN variable is none", () => {
    assert.deepEqual(loadRegistration({}, { vet: ro }), { state: "none" });
    assert.deepEqual(loadRegistration({ GUARD_RUN_ID: "  " }, { vet: ro }), {
        state: "none",
    });
});
void test("registration: id and manifest must be set together", () => {
    assert.equal(denyWhy(loadRegistration({ GUARD_RUN_ID: "r1" }, { vet: ro })), "GUARD_RUN_ID is set but GUARD_RUN_MANIFEST is not");
    assert.equal(denyWhy(loadRegistration({ GUARD_RUN_ID: "r1", GUARD_RUN_MANIFEST: "  " }, { vet: ro })), "GUARD_RUN_ID is set but GUARD_RUN_MANIFEST is not");
    assert.equal(denyWhy(loadRegistration({ GUARD_RUN_MANIFEST: "/x.json" }, { vet: ro })), "GUARD_RUN_MANIFEST is set but GUARD_RUN_ID is not");
    assert.equal(denyWhy(loadRegistration({ GUARD_RUN_MANIFEST: "" }, { vet: ro })), "GUARD_RUN_MANIFEST is set but GUARD_RUN_ID is not");
    assert.equal(loadRegistration({ GUARD_RUN_MANIFEST: "/x.json" }, { vet: ro }).state, "deny");
});
void test("registration: a manifest naming more than one path is refused", () => {
    assert.equal(denyWhy(loadRegistration(envFor("/a.json\n/b.json"), { vet: ro })), "GUARD_RUN_MANIFEST names more than one path");
    assert.equal(denyWhy(loadRegistration(envFor("/a.json\r/b.json"), { vet: ro })), "GUARD_RUN_MANIFEST names more than one path");
});
void test("registration: a missing, mistyped or redirected manifest is refused", () => {
    const missing = join(root, "missing.json");
    assert.equal(denyWhy(loadRegistration(envFor(missing), { vet: ro })), `manifest ${missing} (GUARD_RUN_MANIFEST): no such file`);
    assert.match(denyWhy(loadRegistration(envFor(manifest(MANIFEST, "m.txt")), { vet: ro })), /\(GUARD_RUN_MANIFEST\): not a \.json file$/);
    const dir = fresh("x.json");
    mkdirSync(dir);
    assert.match(denyWhy(loadRegistration(envFor(dir), { vet: ro })), /\(GUARD_RUN_MANIFEST\): not a regular file$/);
    const txt = manifest(MANIFEST, "t.txt");
    const link = fresh("l.json");
    try {
        symlinkSync(txt, link);
    }
    catch {
        return; // no symlink privilege (Windows)
    }
    assert.match(denyWhy(loadRegistration(envFor(link), { vet: ro })), /not a \.json file \(resolves to /);
});
void test("registration: the raw value is printed cut and with control characters replaced", () => {
    const why = denyWhy(loadRegistration(envFor(`/${"a".repeat(300)}\t.json`), { vet: ro }));
    assert.match(why, /^manifest \/a{199}… \(GUARD_RUN_MANIFEST\): /);
});
void test("posix registration: the real vet refuses a manifest this user can write", posixOnly, () => {
    const m = manifest();
    assert.match(denyWhy(loadRegistration(envFor(m))), /\(GUARD_RUN_MANIFEST\): writable by this user/);
});
void test("posix registration: a FIFO is not a regular file and does not block", posixOnly, () => {
    const p = fresh("fifo.json");
    execFileSync("mkfifo", [p]);
    assert.match(denyWhy(loadRegistration(envFor(p), { vet: ro })), /not a regular file$/);
});
void test("registration: a manifest over 64 KiB is refused", () => {
    const m = manifest(" ".repeat(65537));
    assert.match(denyWhy(loadRegistration(envFor(m), { vet: ro })), /\(GUARD_RUN_MANIFEST\): too large \(over 64 KiB\)$/);
});
void test("registration: invalid JSON and unknown capabilities are refused", () => {
    assert.match(denyWhy(loadRegistration(envFor(manifest("{nope")), { vet: ro })), /\(GUARD_RUN_MANIFEST\): invalid: not valid JSON/);
    const bad = manifest(JSON.stringify({ contract: 2, runner: "acme-runner", requires: ["warp"] }));
    assert.match(denyWhy(loadRegistration(envFor(bad), { vet: ro })), /\(GUARD_RUN_MANIFEST\): invalid: /);
});
void test("registration: bad run variables are refused", () => {
    assert.match(denyWhy(loadRegistration(envFor(manifest(), { GUARD_RUN_MODE: "wild" }), {
        vet: ro,
    })), /^run variables: GUARD_RUN_MODE /);
});
void test("registration: a valid manifest registers with its realpath and sha256", () => {
    const m = manifest();
    const r = loadRegistration(envFor(m), { vet: ro });
    assert.equal(r.state, "registered");
    assert.equal(r.path, m);
    assert.equal(r.sha256, sha(MANIFEST));
    assert.equal(r.registration.runner, "acme-runner");
    assert.equal(r.checker, undefined);
});
void test("posix registration: a checker this user can write is refused", posixOnly, () => {
    const checker = fresh("c.mjs");
    writeFileSync(checker, "export default () => [];");
    const body = JSON.stringify({
        contract: 2,
        runner: "acme-runner",
        requires: ["result-gate"],
        result: { file: "r.json", checker },
    });
    const m = manifest(body);
    const why = denyWhy(loadRegistration(envFor(m), {
        vet: { ...ro, writable: (t) => t === checker },
    }));
    assert.match(why, new RegExp(`^result\\.checker ${checker.replace(/[.\\/]/g, "\\$&")} \\(GUARD_RUN_MANIFEST\\): writable by this user`));
});
void test("registration: a trusted checker is returned", () => {
    const checker = fresh("c.mjs");
    writeFileSync(checker, "export default () => [];");
    const m = manifest(JSON.stringify({
        contract: 2,
        runner: "acme-runner",
        requires: ["result-gate"],
        result: { file: "r.json", checker },
    }));
    const r = loadRegistration(envFor(m), { vet: ro });
    assert.equal(r.state, "registered");
    assert.equal(r.checker, checker);
});
void test("posix registration: the first call pins the manifest in a 0700 directory", posixOnly, () => {
    const dataDir = fresh("data");
    const m = manifest();
    const opts = { vet: ro, dataDir, sessionId: "s/1" };
    assert.equal(loadRegistration(envFor(m), opts).state, "registered");
    const pin = pinFile(dataDir, "s/1");
    assert.equal(pin, join(dataDir, "sessions", "s_1.run.jsonl"));
    assert.deepEqual(JSON.parse(readFileSync(pin, "utf8")), {
        manifest: m,
        sha256: sha(MANIFEST),
        run_id: "r1",
        mode: "unattended",
        ticket: "acme/app#7",
    });
    assert.equal(statSync(join(dataDir, "sessions")).mode & 0o777, 0o700);
    assert.equal(loadRegistration(envFor(m), opts).state, "registered");
    assert.equal(readFileSync(pin, "utf8").trim().split("\n").length, 1);
});
void test("registration: no session id means no pin", () => {
    const dataDir = fresh("data");
    assert.equal(loadRegistration(envFor(manifest()), { vet: ro, dataDir }).state, "registered");
    assert.equal(existsSync(dataDir), false);
});
void test("registration: a manifest that changed during the session is refused", () => {
    const dataDir = fresh("data");
    const m = manifest();
    const opts = { vet: ro, dataDir, sessionId: "s2" };
    assert.equal(loadRegistration(envFor(m), opts).state, "registered");
    writeFileSync(m, `${MANIFEST} `);
    assert.equal(denyWhy(loadRegistration(envFor(m), opts)), `manifest changed during the session (sha256 ${sha(MANIFEST).slice(0, 16)}… was pinned)`);
});
void test("registration: a run variable that changed during the session is refused, without its value", () => {
    const dataDir = fresh("data");
    const m = manifest();
    const opts = { vet: ro, dataDir, sessionId: "s3b" };
    assert.equal(loadRegistration(envFor(m), opts).state, "registered");
    assert.equal(loadRegistration(envFor(m, { GUARD_RUN_MODE: "" }), opts).state, "registered", "a blank mode is the unattended default");
    for (const [extra, which] of [
        [{ GUARD_RUN_MODE: "attended" }, "GUARD_RUN_MODE"],
        [{ GUARD_RUN_ID: "r2-secret" }, "GUARD_RUN_ID"],
        [{ GUARD_RUN_TICKET: "acme/app#8" }, "GUARD_RUN_TICKET"],
    ]) {
        assert.equal(denyWhy(loadRegistration(envFor(m, extra), opts)), `run variables changed during the session (${which})`);
    }
    assert.equal(denyWhy(loadRegistration(envFor(m, { GUARD_RUN_MODE: "attended", GUARD_RUN_ID: "r9" }), opts)), "run variables changed during the session (GUARD_RUN_ID, GUARD_RUN_MODE)");
});
void test("registration: a second manifest path in one session is refused", () => {
    const dataDir = fresh("data");
    const opts = { vet: ro, dataDir, sessionId: "s3" };
    assert.equal(loadRegistration(envFor(manifest()), opts).state, "registered");
    assert.equal(denyWhy(loadRegistration(envFor(manifest()), opts)), "GUARD_RUN_MANIFEST names more than one path (another manifest is pinned for this session)");
});
void test("registration: garbage pin lines are ignored and the first valid one is used", () => {
    const dataDir = fresh("data");
    const m = manifest();
    const pin = pinFile(dataDir, "s4");
    mkdirSync(join(dataDir, "sessions"), { recursive: true });
    writeFileSync(pin, [
        "not json",
        "[]",
        JSON.stringify({ manifest: m, sha256: "short" }),
        JSON.stringify({ manifest: m, sha256: sha(MANIFEST) }),
        JSON.stringify({
            manifest: m,
            sha256: sha(MANIFEST),
            run_id: "r1",
            mode: "unattended",
            ticket: "acme/app#7",
        }),
        JSON.stringify({ manifest: "/other.json", sha256: sha("x") }),
    ].join("\n"));
    assert.equal(loadRegistration(envFor(m), { vet: ro, dataDir, sessionId: "s4" }).state, "registered");
});
void test("registration: an unreadable pin file is refused", () => {
    const dataDir = fresh("data");
    mkdirSync(pinFile(dataDir, "s5"), { recursive: true });
    assert.equal(denyWhy(loadRegistration(envFor(manifest()), {
        vet: ro,
        dataDir,
        sessionId: "s5",
    })), "cannot read the session's registration pin (EISDIR)");
});
void test("registration: only a pin failure is marked as one, so the stop can re-check it", () => {
    const dataDir = fresh("data");
    mkdirSync(pinFile(dataDir, "s6"), { recursive: true });
    const pinned = loadRegistration(envFor(manifest()), {
        vet: ro,
        dataDir,
        sessionId: "s6",
    });
    assert.equal(pinned.state === "deny" && pinned.pin, true);
    const bad = loadRegistration(envFor(join(fresh("none"), "gone.json")), {
        vet: ro,
        dataDir,
        sessionId: "s6",
    });
    assert.equal(bad.state, "deny");
    assert.equal("pin" in bad, false);
});
void test("registration: the trust vet and the pin run on every call, cache hit or not", () => {
    const dataDir = fresh("data");
    const m = manifest();
    const cache = createRegistrationCache();
    let vets = 0;
    const vet = {
        ...ro,
        writable: () => {
            vets++;
            return false;
        },
    };
    const opts = { vet, dataDir, sessionId: "s6", cache };
    assert.equal(loadRegistration(envFor(m), opts).state, "registered");
    const first = vets;
    assert.ok(first > 0);
    assert.equal(loadRegistration(envFor(m), opts).state, "registered");
    assert.equal(vets, 2 * first);
    // a changed file (different size) is re-read and the pin denies it
    writeFileSync(m, `${MANIFEST}  `);
    assert.match(denyWhy(loadRegistration(envFor(m), opts)), /changed during/);
    cache.clear();
    assert.equal(cache.entry, undefined);
});
void test("registration: a same-size rewrite that keeps the mtime is detected", () => {
    const m = manifest();
    const { atime, mtime } = statSync(m);
    const dataDir = fresh("data");
    const pinned = {
        vet: ro,
        dataDir,
        sessionId: "s7",
        cache: createRegistrationCache(),
    };
    assert.equal(loadRegistration(envFor(m), pinned).state, "registered");
    writeFileSync(m, MANIFEST.replace("acme-runner", "acme-runnex"));
    utimesSync(m, atime, mtime);
    assert.match(denyWhy(loadRegistration(envFor(m), pinned)), /changed during/);
    // no session: the new content is parsed, not the cached one
    const m2 = manifest();
    const t2 = statSync(m2);
    const bare = { vet: ro, cache: createRegistrationCache() };
    assert.equal(loadRegistration(envFor(m2), bare).state, "registered");
    writeFileSync(m2, "x".repeat(MANIFEST.length));
    utimesSync(m2, t2.atime, t2.mtime);
    assert.match(denyWhy(loadRegistration(envFor(m2), bare)), /: invalid: /);
});
void test("posix registration: a failed pin write is refused", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
    const dataDir = fresh("data");
    mkdirSync(dataDir);
    chmodSync(dataDir, 0o500);
    try {
        assert.match(denyWhy(loadRegistration(envFor(manifest()), {
            vet: ro,
            dataDir,
            sessionId: "s8",
        })), /cannot pin the registration \(EACCES\)/);
    }
    finally {
        chmodSync(dataDir, 0o700);
    }
});
void test("registration: an unusable env value does not throw", () => {
    const env = {
        GUARD_RUN_ID: "r1",
        GUARD_RUN_MANIFEST: { toString: 1 },
    };
    assert.equal(loadRegistration(env, { vet: ro }).state, "deny");
    assert.equal(loadRegistration(null).state, "deny");
});
// A consumer's read-only run: the manifest is a read-only bind-mounted 0444 file owned by another uid, the root
// filesystem is read-only and the session user is not root. The ownership rule is "neither owned nor writable by the
// session user": on a read-only mount the owner check is skipped, so every path is out of reach.
void test("posix registration: a 0444 manifest owned by another uid on a read-only mount is accepted and pinned", posixOnly, () => {
    const p = manifest();
    chmodSync(p, 0o444);
    assert.equal(statSync(p).mode & 0o777, 0o444);
    const real = realpathSync(p);
    const dataDir = fresh("data");
    const opts = {
        dataDir,
        sessionId: "ro",
        vet: {
            writable: () => false,
            owner: () => false,
            readOnlyMount: () => true,
        },
    };
    const got = loadRegistration(envFor(p), opts);
    assert.equal(got.state, "registered", JSON.stringify(got));
    assert.equal(got.path, real);
    assert.ok(existsSync(pinFile(dataDir, "ro")));
    // the pin holds on the next call
    assert.equal(loadRegistration(envFor(p), opts).state, "registered");
});
void test("posix registration: control, the same read-only case with a file the user can write is denied", posixOnly, () => {
    const p = manifest();
    chmodSync(p, 0o444);
    const real = realpathSync(p);
    const why = denyWhy(loadRegistration(envFor(p), {
        dataDir: fresh("data"),
        sessionId: "ro",
        vet: {
            writable: (t) => t === real,
            owner: () => false,
            readOnlyMount: () => true,
        },
    }));
    assert.match(why, /writable by this user \(the file\)/);
});
