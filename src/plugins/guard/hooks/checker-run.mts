// Runs the launcher's result checker in a child process (see checker.mts): receives { href, result, env } over IPC,
// loads the module, calls its resultErrors(result, env) and sends { errors } or { why }, then exits.

import { checkerOutput } from "../core/result.mjs";

const msg = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).slice(0, 200);

interface Job {
  env: Record<string, string | undefined>;
  href: string;
  result: unknown;
}

const send = (m: unknown): Promise<void> =>
  new Promise((done) => {
    if (!process.send) {
      done();
      return;
    }
    process.send(m, () => {
      done();
    });
  });

async function answer({ href, result, env }: Job): Promise<unknown> {
  let mod: { resultErrors?: unknown };
  try {
    mod = (await import(href)) as { resultErrors?: unknown };
  } catch (e: unknown) {
    return { why: `did not load (${msg(e)})` };
  }
  if (typeof mod.resultErrors !== "function") {
    return { why: "exports no resultErrors function" };
  }
  try {
    return checkerOutput(
      await (
        mod.resultErrors as (
          r: unknown,
          e: Record<string, string | undefined>,
        ) => unknown
      )(result, env),
    );
  } catch (e: unknown) {
    return { why: `threw (${msg(e)})` };
  }
}

if (process.send) {
  process.once("message", (job: Job) => {
    void answer(job)
      .then(send)
      .then(() => {
        process.exit(0);
      });
  });
} else {
  process.exit(1);
}
