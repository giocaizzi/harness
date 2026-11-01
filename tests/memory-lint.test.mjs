import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintDir } from "../plugins/dev-tools/skills/host-hygiene/scripts/memory-lint.mjs";
const mem = (files) => {
    const d = mkdtempSync(join(tmpdir(), "memlint-"));
    for (const [f, t] of Object.entries(files))
        writeFileSync(join(d, f), t);
    return d;
};
const ok = (name) => `---\nname: ${name}\ndescription: "a fact"\nmetadata:\n  type: reference\n---\nThe current fact.\n`;
void test("a clean memory dir has no findings", () => {
    const d = mem({ "MEMORY.md": "- [a](a.md) — a fact\n", "a.md": ok("a") });
    assert.deepEqual(lintDir(d), []);
});
void test("flags index drift, bad frontmatter, dangling links and append-style wording", () => {
    const d = mem({
        "MEMORY.md": "- [gone](gone.md) — x\n- [b](b.md) — y\n",
        "b.md": "---\nname: b\ndescription: use this: always\nmetadata:\n  type: opinion\n---\nUpdate: now see [[nope]].\n",
        "c.md": "no frontmatter",
    });
    const f = lintDir(d).map((l) => l.slice(d.length + 1));
    for (const want of [
        "MEMORY.md: links to missing gone.md",
        "c.md: not in MEMORY.md",
        "c.md: no frontmatter",
        "b.md: frontmatter: description needs quotes",
        "b.md: frontmatter: type is opinion",
        "b.md: dangling link [[nope]]",
        'b.md: append-style wording "Update:"',
    ]) {
        assert.ok(f.some((l) => l.startsWith(want)), `missing: ${want}\n${f.join("\n")}`);
    }
});
void test("flags an oversized index and, with --repo, paths that no longer exist", () => {
    const repo = mkdtempSync(join(tmpdir(), "memrepo-"));
    mkdirSync(join(repo, "docs"));
    writeFileSync(join(repo, "docs/here.md"), "x");
    const d = mem({
        "MEMORY.md": "- [a](a.md) — a\n" + "\n".repeat(250),
        "a.md": ok("a").replace("The current fact.", "See `docs/here.md` and `docs/gone.md`."),
    });
    const f = lintDir(d, { repo }).map((l) => l.slice(d.length + 1));
    assert.ok(f.some((l) => l.startsWith("MEMORY.md: 252 lines") || l.startsWith("MEMORY.md: 25")));
    assert.ok(f.some((l) => l.includes("docs/gone.md")));
    assert.ok(!f.some((l) => l.includes("docs/here.md")));
});
