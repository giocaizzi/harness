// The launcher's result checker for the stop hook's result gate: vetting its path, running it in a worker thread.
import { accessSync, constants, existsSync, realpathSync, statSync, } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { checkerPathError, report } from "../core/result.mjs";
import { scrub } from "./telemetry.mjs";
// THE SINGLE TRANSITION SEAM. While the factory plugin ships in this repository, an unset FACTORY_RESULT_CHECKER
// falls back to the build copy of its checker. The change that removes that plugin from this repository deletes
// BUILD_COPY, defaultChecker and DEFAULT_WRITE_HINT; after that, unset means the core check only. The build copy is
// exempt from the writability rule: it is guard's own install.
export const BUILD_COPY = fileURLToPath(new URL("../.generated/factory/check-result.mjs", import.meta.url));
export const defaultChecker = (buildCopy = BUILD_COPY) => existsSync(buildCopy) ? { path: buildCopy } : null;
// Part of the seam: the hand-back line that names the default checker's writer script.
export const DEFAULT_WRITE_HINT = "Write it with the ticket-run skill's scripts/write-result.mjs, never by hand: put the judgment fields in a JSON file and run `node <skill dir>/scripts/write-result.mjs <file>` from the repo; fix the input, never the written file, until it exits 0.";
const STICKY = 0o1000;
const accessCode = (target) => {
    try {
        accessSync(target, constants.W_OK);
        return undefined;
    }
    catch (e) {
        return e.code ?? "unknown";
    }
};
// Whether this user can write `target` right now. EROFS (a read-only mount), EACCES and EPERM mean it cannot; any
// other error is not known to be safe, so it counts as writable (fails closed). On win32 only the access result
// counts (the read-only attribute): ACLs are the launcher's job, and the check does not prove them there.
export function isWritableByMe(target, platform = process.platform) {
    const code = accessCode(target);
    if (code === undefined)
        return true;
    if (platform === "win32")
        return false;
    return !["EROFS", "EACCES", "EPERM"].includes(code);
}
// Whether `target` is on a read-only mount: a file there cannot be chmodded, so owning it gives no reach.
export function isReadOnlyMount(target) {
    return accessCode(target) === "EROFS";
}
// Whether this user owns `target`. Fails closed.
function isOwnedByMe(target) {
    try {
        return statSync(target).uid === process.getuid?.();
    }
    catch {
        return true;
    }
}
function isSticky(target) {
    try {
        return (statSync(target).mode & STICKY) !== 0;
    }
    catch {
        return false;
    }
}
const WRITABLE_TAIL = "install it owned by another user and not writable by this one, or on a read-only mount";
// Vets the raw FACTORY_RESULT_CHECKER value: { path, shown } or { why, shown }. Never throws. The file, its directory
// and every ancestor directory must be out of this user's reach: an owned or plainly writable directory lets the user
// rename it and swap the module between this check and the import (a sticky writable one, like /tmp, does not). A
// path on a read-only mount cannot be chmodded, so there the owner check is skipped for that path.
export function prepareChecker(raw, opts = {}) {
    const platform = opts.platform ?? process.platform;
    const writable = opts.writable ?? ((t) => isWritableByMe(t, platform));
    const owner = opts.owner ?? isOwnedByMe;
    const readOnly = opts.readOnlyMount ?? isReadOnlyMount;
    const sticky = opts.sticky ?? isSticky;
    const shown = typeof raw === "string" ? raw.trim() : "";
    try {
        const bad = checkerPathError(shown, platform === "win32" ? path.win32 : path);
        if (bad)
            return { why: bad, shown };
        let real;
        try {
            real = realpathSync(shown);
        }
        catch (e) {
            const code = e.code;
            return {
                why: code === "ENOENT"
                    ? "no such file"
                    : `cannot resolve (${code ?? "error"})`,
                shown,
            };
        }
        if (path.extname(real).toLowerCase() !== ".mjs") {
            return {
                why: `not a .mjs file (resolves to ${real.length > 200 ? `${real.slice(0, 200)}…` : real})`,
                shown,
            };
        }
        if (!statSync(real).isFile())
            return { why: "not a regular file", shown };
        try {
            accessSync(real, constants.R_OK);
        }
        catch {
            return { why: "not readable", shown };
        }
        const refuse = (which) => ({
            why: `writable by this user (${which}): ${WRITABLE_TAIL}`,
            shown,
        });
        // out of reach: not writable, and (off a read-only mount) not owned either, as the owner can chmod it
        const reach = (t) => writable(t) || (platform !== "win32" && !readOnly(t) && owner(t));
        if (reach(real))
            return refuse("the file");
        if (platform !== "win32") {
            const dir = path.dirname(real);
            if (reach(dir))
                return refuse("its directory");
            for (let a = dir;;) {
                if (!readOnly(a) && (owner(a) || (writable(a) && !sticky(a)))) {
                    return refuse(`ancestor ${a}`);
                }
                const up = path.dirname(a);
                if (up === a)
                    break;
                a = up;
            }
        }
        return { path: real, shown };
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { why: `cannot be checked (${scrub(msg).slice(0, 100)})`, shown };
    }
}
const isStrings = (v) => Array.isArray(v) && v.every((e) => typeof e === "string");
// The worker's message is re-validated here: the checker module could post one of its own.
function acceptMessage(m) {
    if (m !== null && typeof m === "object") {
        const o = m;
        if (isStrings(o.errors) && o.why === undefined) {
            // the worker already capped it (50 lines and a "… and N more" marker): only a message that exceeds that is
            // re-capped, so the marker's count survives
            return {
                errors: o.errors.length <= 51
                    ? o.errors.map((e) => (e.length > 301 ? `${e.slice(0, 300)}…` : e))
                    : report(o.errors),
            };
        }
        if (typeof o.why === "string" && o.errors === undefined) {
            return { why: o.why.slice(0, 300) };
        }
    }
    return { why: "sent an invalid message" };
}
const errText = (e) => scrub(e instanceof Error ? e.message : String(e)).slice(0, 200);
// Runs the checker in a worker thread: resolves { errors } or { why }, never rejects. Its console output is discarded.
export function runChecker(checkerPath, result, env, { timeoutMs = 10_000 } = {}) {
    return new Promise((resolve) => {
        let done = false;
        let worker;
        let timer;
        const finish = (r) => {
            if (done)
                return;
            done = true;
            clearTimeout(timer);
            try {
                worker?.terminate().catch(() => {
                    // already gone
                });
            }
            catch {
                // already gone
            }
            resolve(r);
        };
        try {
            worker = new Worker(new URL("./checker-worker.mjs", import.meta.url), {
                workerData: {
                    href: pathToFileURL(checkerPath).href,
                    result,
                    env: { ...env },
                },
                resourceLimits: { maxOldGenerationSizeMb: 128 },
                stdout: true,
                stderr: true,
            });
            // a checker stuck in a blocking syscall cannot be terminated: it must not keep the process alive
            worker.unref();
            worker.stdout.resume();
            worker.stderr.resume();
            worker.on("message", (m) => {
                finish(acceptMessage(m));
            });
            worker.on("error", (e) => {
                finish({ why: `threw (${errText(e)})` });
            });
            worker.on("exit", (code) => {
                finish({ why: `exited with code ${String(code)} before answering` });
            });
            timer = setTimeout(() => {
                finish({ why: `timed out after ${String(timeoutMs / 1000)} s` });
            }, timeoutMs);
        }
        catch (e) {
            finish({ why: `could not start (${errText(e)})` });
        }
    });
}
