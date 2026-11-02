// PostToolUse hook: after an edit of a shell script run shellcheck, of a .ps1 PSScriptAnalyzer, and hand
// the findings back as additional context. Formatting is left to `make lint`. Missing linter: skip.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isTempPath } from "../core/engine.mjs";
import { isEditTool } from "./harnesses.mjs";
const PS_LINT = "if (Get-Module -ListAvailable -Name PSScriptAnalyzer) { $r = Invoke-ScriptAnalyzer -Path $env:GUARD_LINT_FILE -Severity Error,Warning; " +
    "if ($r) { $r | Format-List RuleName,Line,Message | Out-String } }";
// Edited files: Claude `file_path`, Copilot `path`, VS Code `filePath` or `replacements[].filePath`, and the
// `*** Add/Update File:` lines of an apply_patch (Copilot sends the patch as the whole tool_input, VS Code as `input`,
// Codex as `command`).
export function editedFiles(input) {
    const t = input.tool_input;
    let patch;
    let paths = [];
    if (typeof t === "string") {
        patch = t;
    }
    else if (t && typeof t === "object") {
        const obj = t;
        if (typeof obj.command === "string" &&
            obj.command.trimStart().startsWith("*** Begin Patch")) {
            patch = obj.command;
        }
        else if (typeof obj.input === "string") {
            patch = obj.input;
        }
        else {
            const singlePath = obj.file_path ?? obj.path ?? obj.filePath;
            const repPaths = Array.isArray(obj.replacements)
                ? obj.replacements.map((r) => r.filePath)
                : [];
            paths = [singlePath, ...repPaths];
        }
    }
    if (typeof patch === "string") {
        const matches = [...patch.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm)];
        paths = matches.map((m) => m[1]?.trim());
    }
    const validPaths = paths.filter((p) => typeof p === "string" && p.length > 0);
    const baseDir = input.cwd ?? ".";
    return [...new Set(validPaths.map((p) => resolve(baseDir, p)))];
}
export function lintFile(input, run = spawnSync, platform = process.platform, env = process.env) {
    const tool = input.tool_name ?? "";
    if (!isEditTool(tool) && tool.toLowerCase() !== "apply_patch")
        return null;
    const found = editedFiles(input)
        .map((file) => lintOne(file, run, platform, env))
        .filter((res) => Boolean(res));
    if (!found.length)
        return null;
    const context = found.join("\n\n");
    // Claude and VS Code read hookSpecificOutput; Copilot CLI reads the top-level additionalContext.
    return {
        additionalContext: context,
        hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext: context,
        },
    };
}
// A shell script shellcheck can read: a bash, sh, dash or ksh shebang, or none. zsh, fish and the rest are skipped.
const POSIX_SHEBANG = /^#!\s*(?:\S*\/)?(?:env\s+(?:-\S+\s+)*)?(?:ba|da|k)?sh\b/;
function lintOne(file, run, platform, env) {
    // Scratch files in a temp dir are not the repo's to fix.
    if (!existsSync(file) || isTempPath(file, env))
        return null;
    const opts = {
        encoding: "utf8",
        timeout: 50_000,
        windowsHide: true,
    };
    let out = "";
    if (/\.(sh|bash)$/i.test(file)) {
        const content = readFileSync(file, "utf8");
        const first = content.split("\n", 1)[0] ?? "";
        if (first.startsWith("#!") && !POSIX_SHEBANG.test(first))
            return null;
        const r = run("shellcheck", [file], opts);
        if (!r.error && r.status !== 0) {
            out = `${r.stdout}${r.stderr}`;
        }
    }
    else if (/\.ps1$/i.test(file)) {
        const r = run(platform === "win32" ? "powershell" : "pwsh", ["-NoProfile", "-Command", PS_LINT], { ...opts, env: { ...process.env, GUARD_LINT_FILE: file } });
        if (!r.error && r.status === 0) {
            out = r.stdout;
        }
    }
    const trimmed = out.trim();
    return trimmed ? `Lint findings in ${file}; fix them:\n${trimmed}` : null;
}
const entryArg = process.argv[1];
if (entryArg && import.meta.url === pathToFileURL(entryArg).href) {
    try {
        const raw = readFileSync(0, "utf8");
        const parsed = JSON.parse(raw || "{}");
        const out = lintFile(parsed);
        if (out)
            process.stdout.write(JSON.stringify(out));
    }
    catch {
        // unreadable payload: nothing to lint
    }
}
