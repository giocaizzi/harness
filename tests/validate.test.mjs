import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evalCaseErrors } from "../scripts/validate.mjs";
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
