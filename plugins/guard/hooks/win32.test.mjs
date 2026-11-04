import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { handle, pythonManager } from "./guard.mjs";
// Run on a Windows host only (CI's `windows-scripts` job): a registered unattended run, the PowerShell tool and a real
// temporary repo, so the paths are the host's own (`C:\Users\...`, 8.3 names and all).
const skip = process.platform !== "win32";
const manifest = join(mkdtempSync(join(tmpdir(), "guard-win32-reg-")), "m.json");
writeFileSync(manifest, JSON.stringify({
    contract: 2,
    runner: "acme-runner",
    labels: { approval: "agent-ok", takeover: "factory-takeover" },
    requires: ["labels"],
}));
const RO = {
    writable: () => false,
    owner: () => false,
    readOnlyMount: () => false,
};
const dataDir = mkdtempSync(join(tmpdir(), "guard-win32-data-"));
const repo = realpathSync(mkdtempSync(join(tmpdir(), "guard-win32-repo-")));
mkdirSync(join(repo, ".git"));
const denied = async (input) => {
    const out = await handle({ session_id: "s1", cwd: repo, ...input }, {
        dataDir,
        env: {
            GUARD_RUN_ID: "r1",
            GUARD_RUN_TICKET: "acme/app#7",
            GUARD_RUN_MANIFEST: manifest,
            GUARD_OTEL: "off",
        },
        hostFacts: () => Promise.resolve({ load1: 1, freeGb: 100 }),
        run: () => Promise.resolve(null),
        pythonManager,
        runVet: RO,
    });
    if (!out.stdout)
        return false;
    const parsed = JSON.parse(out.stdout);
    return parsed.hookSpecificOutput?.permissionDecision === "deny";
};
const powershell = (command) => ({
    hook_event_name: "PreToolUse",
    tool_name: "PowerShell",
    tool_input: { command },
});
void test("win32: PowerShell writes to an ordinary backslash path pass; a protected one, a share and a stream are denied", { skip }, async () => {
    for (const command of [
        String.raw `Set-Content C:\temp\x.txt a`,
        String.raw `Set-Content -Path ${repo}\src\x -Value a`,
        String.raw `Get-Date | Out-File C:\temp\x.txt`,
        String.raw `Out-File -FilePath C:\Users\runneradmin\Desktop\x.txt`,
        String.raw `Remove-Item ${repo}\build -Recurse`,
        String.raw `echo a > C:\temp\x.txt`,
        String.raw `cd C:\temp; echo a > x.txt`,
        String.raw `Copy-Item x ..\..`,
        String.raw `Set-Content -Path C:\Temp\out.txt -Value a`,
        `Set-Content 'C:\\temp\\x.txt' a`,
        "echo a > C:/temp/x.txt",
        String.raw `Set-Content $env:TEMP\x.txt a`,
        'Set-Content log.txt "error: failed"',
    ])
        assert.equal(await denied(powershell(command)), false, command);
    for (const command of [
        String.raw `Set-Content ${repo}\.github\x a`,
        `Set-Content '${repo}\\.github\\x' a`,
        `Set-Content "${repo}\\.github\\x" a`,
        String.raw `Set-Content -Path ${repo.slice(2)}\.github\x -Value a`,
        String.raw `Set-Content \\localhost\C$\x\y a`,
        "Set-Content '.github::$INDEX_ALLOCATION/workflows/ci.yml' a",
    ])
        assert.equal(await denied(powershell(command)), true, command);
});
void test("win32: the edit tool denies a protected path in the host's own spelling, a share and a stream", { skip }, async () => {
    const edit = (file_path) => ({
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path },
    });
    for (const file of [
        String.raw `${repo}\.github\x`,
        `${repo}/.github/x`,
        String.raw `${repo}\.github::$INDEX_ALLOCATION\x`,
        String.raw `\\localhost\C$\x`,
    ])
        assert.equal(await denied(edit(file)), true, file);
    assert.equal(await denied(edit(String.raw `${repo}\src\x`)), false);
});
