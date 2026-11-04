// Runs the launcher's result checker in a child process (see checker.mts): receives { href, result, env } over IPC,
// loads the module, calls its resultErrors(result, env) and sends { errors } or { why }, then exits.
import { checkerOutput } from "../core/result.mjs";
const msg = (e) => (e instanceof Error ? e.message : String(e)).slice(0, 200);
const send = (m) => new Promise((done) => {
    if (!process.send) {
        done();
        return;
    }
    process.send(m, () => {
        done();
    });
});
async function answer({ href, result, env }) {
    let mod;
    try {
        mod = (await import(href));
    }
    catch (e) {
        return { why: `did not load (${msg(e)})` };
    }
    if (typeof mod.resultErrors !== "function") {
        return { why: "exports no resultErrors function" };
    }
    try {
        return checkerOutput(await mod.resultErrors(result, env));
    }
    catch (e) {
        return { why: `threw (${msg(e)})` };
    }
}
if (process.send) {
    process.once("message", (job) => {
        void answer(job)
            .then(send)
            .then(() => {
            process.exit(0);
        });
    });
}
else {
    process.exit(1);
}
