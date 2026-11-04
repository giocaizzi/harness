// The launcher's result checker: vetting its path and running it in a child process. Tests named `result check:` run on
// every OS; the ones that need POSIX permissions are named `posix checker:` and skip on Windows.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import {
  BUILD_COPY,
  defaultChecker,
  isWritableByMe,
  prepareChecker,
  runChecker,
} from "./checker.mjs";

const root = realpathSync(mkdtempSync(join(tmpdir(), "guard-checker-")));
after(() => {
  rmSync(root, { recursive: true, force: true });
});
let n = 0;
const file = (body: string): string => {
  const p = join(root, `c${String(n++)}.mjs`);
  writeFileSync(p, body);
  return p;
};
const ro = {
  writable: () => false,
  owner: () => false,
  readOnlyMount: () => false,
};
const posixOnly = { skip: process.platform === "win32" };

const run = async (body: string, opts: { timeoutMs?: number } = {}) => {
  const c = prepareChecker(file(body), ro);
  assert.ok("path" in c, "why" in c ? c.why : "");
  return runChecker(c.path, { run_id: "r" }, {}, opts);
};
const why = (r: unknown): string => (r as { why: string }).why;

void test("result check: paths that are not files are refused with a reason", () => {
  assert.equal(
    prepareChecker(join(root, "missing.mjs"), ro).shown !== "",
    true,
  );
  assert.deepEqual(prepareChecker(join(root, "missing.mjs"), ro), {
    why: "no such file",
    shown: join(root, "missing.mjs"),
  });
  assert.match(why(prepareChecker("rel/c.mjs", ro)), /not an absolute path/);
  assert.match(
    why(prepareChecker("file:///x/c.mjs", ro)),
    /URL or module specifier/,
  );
  assert.match(
    why(prepareChecker("data:text/javascript,export default 1", ro)),
    /URL or module specifier/,
  );
  assert.match(why(prepareChecker("node:fs", ro)), /URL or module specifier/);
  assert.equal(why(prepareChecker("", ro)), "empty");
  assert.equal(why(prepareChecker(undefined, ro)), "empty");
  assert.equal(why(prepareChecker("  \n", ro)), "empty");
});

void test("result check: Windows path rules apply when the platform is win32", () => {
  assert.match(
    why(prepareChecker("/a/c.mjs", { ...ro, platform: "win32" })),
    /not an absolute path/,
  );
  assert.match(
    why(prepareChecker("C:c.mjs", { ...ro, platform: "win32" })),
    /not an absolute path/,
  );
  assert.match(
    why(prepareChecker("\\\\?\\C:\\c.mjs", { ...ro, platform: "win32" })),
    /not an absolute path/,
  );
});

void test("result check: a directory named .mjs is not a regular file", () => {
  const d = join(root, "dir.mjs");
  mkdirSync(d);
  assert.equal(why(prepareChecker(d, ro)), "not a regular file");
});

void test("result check: a CRLF-suffixed value is accepted as its trimmed path", () => {
  const p = file("export const resultErrors = () => []");
  const c = prepareChecker(`${p}\r\n`, ro);
  assert.ok("path" in c);
  assert.equal(c.shown, p);
});

void test("result check: a vetted checker returns its real path", () => {
  const p = file("export const resultErrors = () => []");
  assert.deepEqual(prepareChecker(p, ro), { path: p, shown: p });
});

void test("result check: the default checker is the build copy when it exists", () => {
  const p = file("export const resultErrors = () => []");
  assert.deepEqual(defaultChecker(p), { path: p });
  assert.equal(defaultChecker(join(root, "none.mjs")), null);
  assert.ok(BUILD_COPY.endsWith("check-result.mjs"));
});

void test(
  "posix checker: a file this user owns or can write is refused, even read-only",
  posixOnly,
  () => {
    const p = file("export const resultErrors = () => []");
    assert.match(why(prepareChecker(p)), /^writable by this user \(the file\)/);
    chmodSync(p, 0o444);
    assert.match(why(prepareChecker(p)), /^writable by this user \(the file\)/);
    // not writable, but the owner could chmod it: the owner check refuses it, not the access check
    assert.equal(isWritableByMe(p), false);
  },
);

void test(
  "posix checker: a file and directory this user owns pass on a read-only mount, an owned ancestor above it does not",
  posixOnly,
  () => {
    const p = file("export const resultErrors = () => []");
    const dir = dirname(p);
    const up = dirname(dir);
    const mount = {
      writable: () => false,
      readOnlyMount: (t: string) => t === p || t === dir,
    };
    assert.deepEqual(
      prepareChecker(p, { ...mount, owner: (t) => t === p || t === dir }),
      {
        path: p,
        shown: p,
      },
    );
    assert.match(
      why(prepareChecker(p, { ...mount, owner: (t) => t === up })),
      /\(ancestor /,
    );
    // off the mount, ownership still refuses
    assert.match(
      why(
        prepareChecker(p, {
          ...mount,
          readOnlyMount: () => false,
          owner: (t) => t === p,
        }),
      ),
      /\(the file\)/,
    );
  },
);

void test(
  "posix checker: a .mjs symlink to a file that is not .mjs is refused",
  posixOnly,
  () => {
    const target = join(root, `t${String(n++)}.js`);
    writeFileSync(target, "export const resultErrors = () => []");
    const link = join(root, `l${String(n++)}.mjs`);
    symlinkSync(target, link);
    assert.equal(
      why(prepareChecker(link, ro)),
      `not a .mjs file (resolves to ${target})`,
    );
    const ok = join(root, `l${String(n++)}.mjs`);
    symlinkSync(file("export const resultErrors = () => []"), ok);
    assert.ok("path" in prepareChecker(ok, ro));
  },
);

void test(
  "posix checker: isWritableByMe is false for a file this user cannot write and fails closed on an unknown error",
  posixOnly,
  () => {
    if (process.getuid?.() !== 0)
      assert.equal(isWritableByMe("/etc/hosts"), false);
    assert.equal(isWritableByMe(join(root, "gone.mjs")), true);
    assert.equal(
      isWritableByMe("/etc/hosts", "win32"),
      process.getuid?.() === 0,
    );
  },
);

void test("posix checker: an unreadable file is refused", posixOnly, () => {
  if (process.getuid?.() === 0) return;
  const p = file("export const resultErrors = () => []");
  chmodSync(p, 0o000);
  assert.equal(why(prepareChecker(p, ro)), "not readable");
});

void test(
  "posix checker: the directory and every ancestor must be out of reach",
  posixOnly,
  () => {
    const p = file("export const resultErrors = () => []");
    const dir = dirname(p);
    const up = dirname(dir);
    assert.match(
      why(prepareChecker(p, { ...ro, owner: (t) => t === dir })),
      /\(its directory\)/,
    );
    assert.match(
      why(prepareChecker(p, { ...ro, writable: (t) => t === dir })),
      /\(its directory\)/,
    );
    assert.match(
      why(prepareChecker(p, { ...ro, owner: (t) => t === up })),
      new RegExp(`\\(ancestor ${up.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}\\)`),
    );
    assert.match(
      // not sticky: the temp dir's parent is a sticky /tmp on Linux
      why(
        prepareChecker(p, {
          ...ro,
          writable: (t) => t === up,
          sticky: () => false,
        }),
      ),
      /\(ancestor /,
    );
    assert.match(
      why(prepareChecker(p, { ...ro, writable: (t) => t === "/" })),
      /\(ancestor \/\)/,
    );
    assert.match(
      why(
        prepareChecker(p, {
          ...ro,
          writable: (t) => t === up,
          sticky: () => false,
        }),
      ),
      /\(ancestor /,
    );
    // a sticky writable ancestor (like /tmp) is fine; an owned one never is
    assert.ok(
      "path" in
        prepareChecker(p, {
          ...ro,
          writable: (t) => t === up,
          sticky: (t) => t === up,
        }),
    );
    assert.match(
      why(
        prepareChecker(p, {
          ...ro,
          owner: (t) => t === up,
          sticky: (t) => t === up,
        }),
      ),
      /\(ancestor /,
    );
  },
);

void test("result check: returns the checker errors, or none", async () => {
  assert.deepEqual(await run("export const resultErrors = () => ['bad']"), {
    errors: ["bad"],
  });
  assert.deepEqual(await run("export const resultErrors = () => []"), {
    errors: [],
  });
  assert.deepEqual(
    await run("export const resultErrors = async () => ['late']"),
    { errors: ["late"] },
  );
});

void test("result check: the checker gets the result and the environment", async () => {
  const c = prepareChecker(
    file(
      "export const resultErrors = (r, env) => [`${r.run_id}/${env.FACTORY_X}`]",
    ),
    ro,
  );
  assert.ok("path" in c);
  assert.deepEqual(
    await runChecker(c.path, { run_id: "r1" }, { FACTORY_X: "x" }),
    {
      errors: ["r1/x"],
    },
  );
});

void test("result check: every failure mode is a why", async () => {
  assert.match(
    why(
      await run(
        "export const resultErrors = () => { throw new Error('boom') }",
      ),
    ),
    /^threw \(boom\)/,
  );
  assert.match(
    why(await run("throw new Error('at import')")),
    /^did not load \(at import\)/,
  );
  assert.match(why(await run("export const = ;")), /^did not load \(/);
  assert.deepEqual(await run("export const other = 1"), {
    why: "exports no resultErrors function",
  });
  assert.match(
    why(await run("export const resultErrors = () => 'x'")),
    /^returned "x", not an array of strings/,
  );
  assert.match(
    why(await run("export const resultErrors = () => [1]")),
    /not an array of strings/,
  );
  assert.match(
    why(await run("export const resultErrors = () => process.exit(3)")),
    /^exited with code 3 before answering/,
  );
});

void test("result check: a sync infinite loop times out promptly", async () => {
  const t = Date.now();
  const r = await run("export const resultErrors = () => { for (;;); }", {
    timeoutMs: 300,
  });
  assert.equal(why(r), "timed out after 0.3 s");
  assert.ok(Date.now() - t < 5000);
});

void test("result check: more than 50 errors are capped", async () => {
  const r = (await run(
    "export const resultErrors = () => Array.from({ length: 80 }, (_, i) => 'e' + i)",
  )) as { errors: string[] };
  assert.equal(r.errors.length, 51);
  assert.equal(r.errors[50], "… and 30 more");
});

void test("result check: a message the module posts itself is validated", async () => {
  const post = (m: string) =>
    run(
      `process.send(${m})
export const resultErrors = () => []`,
    );
  assert.deepEqual(await post("{ errors: [1] }"), {
    why: "sent an invalid message",
  });
  assert.deepEqual(await post("{ why: 5 }"), {
    why: "sent an invalid message",
  });
  assert.deepEqual(await post("'text'"), { why: "sent an invalid message" });
  assert.deepEqual(await post("{ errors: ['a'], why: 'b' }"), {
    why: "sent an invalid message",
  });
  const long = (await post("{ why: 'w'.repeat(900) }")) as { why: string };
  assert.equal(long.why.length, 300);
  const many = (await post(
    "{ errors: Array.from({ length: 90 }, () => 'z') }",
  )) as { errors: string[] };
  assert.equal(many.errors.length, 51);
});

void test("result check: a checker that floods its console cannot corrupt the hook stdout", () => {
  const checker = file(
    "export const resultErrors = () => { for (let i = 0; i < 2000; i++) { console.log('flood ' + i); console.error('flood') } return ['x'] }",
  );
  const script =
    file(`import { prepareChecker, runChecker } from ${JSON.stringify(new URL("./checker.mjs", import.meta.url).href)}
const c = prepareChecker(${JSON.stringify(checker)}, { writable: () => false, owner: () => false })
process.stdout.write(JSON.stringify(await runChecker(c.path, {}, {})))`);
  const out = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), { errors: ["x"] });
});

// A checker that blocks in a syscall: a read of a FIFO nobody writes to. The child is killed, never joined.
const fifo = (): string => {
  const p = join(root, `fifo${String(n++)}`);
  assert.equal(spawnSync("mkfifo", [p]).status, 0);
  return p;
};

void test(
  "posix checker: a resultErrors blocked reading a FIFO times out",
  posixOnly,
  async () => {
    const f = fifo();
    const t = Date.now();
    const r = await run(
      `import { readFileSync } from 'node:fs'
export const resultErrors = () => { readFileSync(${JSON.stringify(f)}); return [] }`,
      { timeoutMs: 500 },
    );
    assert.equal(why(r), "timed out after 0.5 s");
    assert.ok(Date.now() - t < 5000);
  },
);

void test(
  "posix checker: a top-level import blocked reading a FIFO times out",
  posixOnly,
  async () => {
    const f = fifo();
    const t = Date.now();
    const r = await run(
      `import { readFileSync } from 'node:fs'
readFileSync(${JSON.stringify(f)})
export const resultErrors = () => []`,
      { timeoutMs: 500 },
    );
    assert.equal(why(r), "timed out after 0.5 s");
    assert.ok(Date.now() - t < 5000);
  },
);

void test(
  "posix checker: a hook that never calls process.exit ends on its own after a FIFO-blocked checker",
  posixOnly,
  () => {
    const checker = file(
      `import { readFileSync } from 'node:fs'
export const resultErrors = () => { readFileSync(${JSON.stringify(fifo())}); return [] }`,
    );
    const script =
      file(`import { prepareChecker, runChecker } from ${JSON.stringify(new URL("./checker.mjs", import.meta.url).href)}
const c = prepareChecker(${JSON.stringify(checker)}, { writable: () => false, owner: () => false })
process.stdout.write(JSON.stringify(await runChecker(c.path, {}, {}, { timeoutMs: 500 })))`);
    const out = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(out.error, undefined);
    assert.equal(out.signal, null);
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(JSON.parse(out.stdout), { why: "timed out after 0.5 s" });
  },
);

void test(
  "posix checker: a checker killed by a signal is a why",
  posixOnly,
  async () => {
    assert.match(
      why(
        await run(
          "export const resultErrors = () => process.kill(process.pid, 'SIGKILL')",
        ),
      ),
      /^exited with signal SIGKILL before answering/,
    );
  },
);
