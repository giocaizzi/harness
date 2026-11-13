import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evalCaseErrors, skillDescriptionError } from "../scripts/validate.mjs";
const writeCase = (root, plugin, name, text) => {
    const dir = join(root, plugin, "evals", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "case.yaml"), text);
};
void test("evalCaseErrors: valid case.yaml files pass", () => {
    const root = mkdtempSync(join(tmpdir(), "validate-evals-"));
    writeCase(root, "infra", "docker-trigger", "name: docker-trigger\ntags: [trigger]\n");
    mkdirSync(join(root, "go"), { recursive: true });
    assert.deepEqual(evalCaseErrors(root), []);
});
void test("evalCaseErrors: invalid YAML and duplicate keys fail, naming the file", () => {
    const root = mkdtempSync(join(tmpdir(), "validate-evals-"));
    writeCase(root, "infra", "ok", "name: ok\n");
    writeCase(root, "infra", "broken", "execution:\n  prompt: [unclosed\n");
    writeCase(root, "python", "dupe", "name: a\nname: b\n");
    const errors = evalCaseErrors(root);
    assert.equal(errors.length, 2);
    assert.match(errors[0] ?? "", /^plugins\/infra\/evals\/broken\/case\.yaml: invalid YAML/);
    assert.match(errors[1] ?? "", /^plugins\/python\/evals\/dupe\/case\.yaml: invalid YAML/);
});
void test("skillDescriptionError: 400 characters pass, 401 fail naming the skill and the limit", () => {
    const front = (n) => `name: x\ndescription: ${"a".repeat(n)}\n`;
    assert.equal(skillDescriptionError("x", front(400)), null);
    const error = skillDescriptionError("x", front(401));
    assert.match(error ?? "", /^skills\/x: description is 401 characters, over the 400 limit/);
});
void test("skillDescriptionError: missing frontmatter, no description or invalid YAML are not this check's", () => {
    assert.equal(skillDescriptionError("x", undefined), null);
    assert.equal(skillDescriptionError("x", "name: x\n"), null);
    assert.equal(skillDescriptionError("x", "description: [unclosed\n"), null);
});
