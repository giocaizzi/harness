// Runs the launcher's result checker off the hook's main thread (see checker.mts): loads the module, calls its
// resultErrors(result, env) and posts { errors } or { why }.

import { parentPort, workerData } from "node:worker_threads";

import { checkerOutput } from "../core/result.mjs";

const msg = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).slice(0, 200);
const post = (m: unknown): void => {
  parentPort?.postMessage(m);
};

const { href, result, env } = workerData as {
  env: Record<string, string | undefined>;
  href: string;
  result: unknown;
};

let mod: { resultErrors?: unknown } | undefined;
try {
  mod = (await import(href)) as { resultErrors?: unknown };
} catch (e: unknown) {
  post({ why: `did not load (${msg(e)})` });
}
if (mod) {
  if (typeof mod.resultErrors !== "function") {
    post({ why: "exports no resultErrors function" });
  } else {
    try {
      post(
        checkerOutput(
          await (
            mod.resultErrors as (
              r: unknown,
              e: Record<string, string | undefined>,
            ) => unknown
          )(result, env),
        ),
      );
    } catch (e: unknown) {
      post({ why: `threw (${msg(e)})` });
    }
  }
}
