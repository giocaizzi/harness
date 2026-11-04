import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
// The source and the emitted file sit at different depths: walk up to the repo's docs, and stop at the filesystem root
// (an installed plugin copy has no docs).
let root = dirname(fileURLToPath(import.meta.url));
while (!existsSync(join(root, "docs", "guard.md"))) {
    if (dirname(root) === root)
        throw new Error("docs/guard.md not found in any directory above this test: run it from a checkout of the repo");
    root = dirname(root);
}
const doc = readFileSync(join(root, "docs", "guard.md"), "utf8");
// The fenced json block that follows the paragraph containing `intro`.
const exampleAfter = (intro) => {
    const at = doc.indexOf(intro);
    assert.notEqual(at, -1, `docs/guard.md has no "${intro}"`);
    const m = /```json\n([\s\S]*?)\n```/.exec(doc.slice(at));
    assert.ok(m?.[1] !== undefined, `no json block after "${intro}"`);
    return m[1];
};
for (const intro of [
    "The tripwire line has no paths and no env values:",
    "prints one JSON line and exits 0 without reading stdin:",
]) {
    void test(`docs/guard.md: the example after "${intro.slice(0, 30)}" is one line of JSON`, () => {
        const block = exampleAfter(intro);
        assert.equal(block.includes("\n"), false, "the example spans lines");
        assert.doesNotThrow(() => JSON.parse(block));
    });
}
