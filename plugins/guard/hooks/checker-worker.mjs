// Runs the launcher's result checker off the hook's main thread (see checker.mts): loads the module, calls its
// resultErrors(result, env) and posts { errors } or { why }.
import { parentPort, workerData } from "node:worker_threads";
import { checkerOutput } from "../core/result.mjs";
const msg = (e) => (e instanceof Error ? e.message : String(e)).slice(0, 200);
const post = (m) => {
    parentPort?.postMessage(m);
};
const { href, result, env } = workerData;
let mod;
try {
    mod = (await import(href));
}
catch (e) {
    post({ why: `did not load (${msg(e)})` });
}
if (mod) {
    if (typeof mod.resultErrors !== "function") {
        post({ why: "exports no resultErrors function" });
    }
    else {
        try {
            post(checkerOutput(await mod.resultErrors(result, env)));
        }
        catch (e) {
            post({ why: `threw (${msg(e)})` });
        }
    }
}
