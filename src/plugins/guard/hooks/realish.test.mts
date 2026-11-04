import assert from "node:assert/strict";
import { win32 } from "node:path";
import { test } from "node:test";

import { realish } from "./guard.mjs";
import type { LinkEnv } from "./guard.mjs";

// A Windows tree of links (lowercase, `\` paths); every other path is a plain directory or missing.
const links: Record<string, string> = {
  "c:\\r\\d": "C:\\other",
  "c:\\r\\n": "d\\..\\z",
};
const env: LinkEnv = {
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
  const loop: LinkEnv = {
    ...env,
    isLink: () => true,
    readLink: () => "a",
  };
  assert.equal(realish("C:\\a", false, loop), null);
});
