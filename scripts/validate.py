#!/usr/bin/env python3
"""Validate repo invariants for the dual-harness plugin layout.

Schema checks for the Claude plugin manifest, SKILL.md frontmatter and the
marketplace manifest are delegated to the native `claude plugin validate`
command. This file only enforces things the native validator cannot see:
the Copilot-side manifest, marketplace ↔ disk cross-refs, README sync,
generated-agent sync, and a couple of repo-specific rules.

Checks:
  1. Native `claude plugin validate` passes for every plugin and the marketplace.
  2. The Copilot manifest (.github/plugin/plugin.json) matches the Claude
     manifest's version and sets `agents: ["./.generated/copilot/"]`.
  3. The Claude plugin.json does not declare `skills` or `agents` fields
     (repo policy: both must be auto-discovered), and no plugin has a `bin/` (claude.ai and Cowork skip it).
  4. marketplace.json lists every plugins/<dir> with matching versions and source paths.
  5. The root README links to every plugin, and each plugin's README lists all its skills and agents.
  6. Generated files are in sync with agents/*.md, their .yaml overrides, the manifests and the cross-plugin copies (delegates to build_agents.py --check).
  7. Every file a plugin's hooks/hooks.json names (command scripts, mod modules) exists.
  8. VS Code reads each plugin as Claude format: no `.plugin/plugin.json` or root
     `plugin.json` (they win VS Code's format detection), skill `name` is kebab-case
     and equals its directory (VS Code skips others silently), frontmatter is strict YAML
     (Copilot CLI and VS Code reject it otherwise), hook events are ones
     VS Code maps, and hook commands use no `${CLAUDE_PLUGIN_DATA}` token (VS Code
     expands only `${CLAUDE_PLUGIN_ROOT}`).
  9. pi reads the repo-root package.json: its `pi` key loads every plugin's skills and the guard extension.
 10. Parity: every skill and agent reaches Claude Code, Copilot CLI, Codex, opencode, pi and Antigravity through
     the repo's own packaging, each agent at one tier (delegates to scripts/parity.mjs).
 11. Skills are self-contained: no skill file (.md or script) points at this repo's docs/ (a `../docs`
     path, or a relative `docs/<path>` that is a file here), since an installed skill ships without them.
 12. TypeScript compilation succeeds and every emitted runtime file matches its tracked output.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
PLUGINS_ROOT = REPO_ROOT / "plugins"
MARKETPLACE = REPO_ROOT / ".claude-plugin" / "marketplace.json"
README = REPO_ROOT / "README.md"
PYPROJECT = REPO_ROOT / "pyproject.toml"


class Reporter:
    def __init__(self) -> None:
        self.errors: list[str] = []

    def fail(self, msg: str) -> None:
        self.errors.append(msg)

    def section(self, title: str) -> None:
        print(f"\n> {title}")

    def ok(self, msg: str) -> None:
        print(f"  OK {msg}")


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _load_toml(path: Path) -> dict:
    return tomllib.loads(path.read_text(encoding="utf-8"))


def _discover_plugins() -> list[Path]:
    return sorted(p for p in PLUGINS_ROOT.iterdir() if p.is_dir() and not p.name.startswith("."))


def _run_claude_validate(target: Path) -> tuple[bool, str]:
    result = subprocess.run(
        ["claude", "plugin", "validate", str(target)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    return result.returncode == 0, (result.stdout + result.stderr).strip()


def check_native_validator(r: Reporter) -> None:
    r.section("Native `claude plugin validate`")
    if shutil.which("claude") is None:
        r.fail("claude CLI not found on PATH - install Claude Code to run native plugin validation")
        return

    for plugin_dir in _discover_plugins():
        ok, output = _run_claude_validate(plugin_dir)
        label = plugin_dir.relative_to(REPO_ROOT)
        if not ok:
            r.fail(f"{label}: native validator failed\n{output}")
        else:
            r.ok(f"{label}")

    ok, output = _run_claude_validate(MARKETPLACE)
    label = MARKETPLACE.relative_to(REPO_ROOT)
    if not ok:
        r.fail(f"{label}: native validator failed\n{output}")
    else:
        r.ok(f"{label}")


def check_repo_specific_manifests(r: Reporter) -> None:
    r.section("Repo-specific manifest rules (Copilot + auto-discovery)")
    for plugin_dir in _discover_plugins():
        manifest = plugin_dir / ".claude-plugin" / "plugin.json"
        rel = manifest.relative_to(REPO_ROOT)
        if (plugin_dir / "bin").exists():
            r.fail(f"{plugin_dir.relative_to(REPO_ROOT)}/bin exists: claude.ai and Cowork do not install a plugin with a bin/; name scripts by ${{CLAUDE_PLUGIN_ROOT}} in the skill")
        if not manifest.exists():
            continue
        try:
            data = _load_json(manifest)
        except json.JSONDecodeError:
            continue
        if "skills" in data:
            r.fail(f"{rel}: contains `skills` field - Claude Code rejects this; remove it (auto-discovery works for both harnesses)")
        if "agents" in data:
            r.fail(f"{rel}: contains `agents` field - Claude Code reads this manifest; it must auto-discover the agents/ dir. The `agents` override belongs in .github/plugin/plugin.json (Copilot).")

        copilot_manifest = plugin_dir / ".github" / "plugin" / "plugin.json"
        crel = copilot_manifest.relative_to(REPO_ROOT)
        if not copilot_manifest.exists():
            r.fail(f"{crel}: missing - Copilot CLI needs this manifest (run `make build`)")
            continue
        try:
            cdata = _load_json(copilot_manifest)
        except json.JSONDecodeError as e:
            r.fail(f"{crel}: invalid JSON: {e}")
            continue
        if cdata.get("version") != data.get("version"):
            r.fail(f"{crel}: version drift vs .claude-plugin/plugin.json ({cdata.get('version')!r} vs {data.get('version')!r}) - run `make build`")
        if cdata.get("agents") != ["./.generated/copilot/"]:
            r.fail(f"{crel}: must contain `\"agents\": [\"./.generated/copilot/\"]` so Copilot CLI scans .generated/copilot/ (got {cdata.get('agents')!r})")

        antigravity_manifest = plugin_dir / ".antigravity-plugin" / "plugin.json"
        arel = antigravity_manifest.relative_to(REPO_ROOT)
        if not antigravity_manifest.exists():
            r.fail(f"{arel}: missing - Antigravity needs this manifest (run `make build`)")
            continue
        try:
            adata = _load_json(antigravity_manifest)
        except json.JSONDecodeError as e:
            r.fail(f"{arel}: invalid JSON: {e}")
            continue
        if adata.get("version") != data.get("version"):
            r.fail(f"{arel}: version drift vs .claude-plugin/plugin.json ({adata.get('version')!r} vs {data.get('version')!r}) - run `make build`")
        r.ok(f"{plugin_dir.name} (Claude + Copilot + Antigravity manifests)")


def check_marketplace(r: Reporter) -> None:
    r.section("Marketplace <-> plugins sync")
    if not MARKETPLACE.exists():
        r.fail(f"{MARKETPLACE.relative_to(REPO_ROOT)}: missing")
        return
    try:
        market = _load_json(MARKETPLACE)
    except json.JSONDecodeError as e:
        r.fail(f"{MARKETPLACE.relative_to(REPO_ROOT)}: invalid JSON: {e}")
        return

    listed = {p["name"]: p for p in market.get("plugins", [])}
    on_disk = {p.name for p in _discover_plugins()}

    for name in on_disk - listed.keys():
        r.fail(f"plugin {name!r} exists on disk but is not in marketplace.json")
    for name in listed.keys() - on_disk:
        r.fail(f"marketplace.json lists {name!r} but plugins/{name}/ does not exist")

    for name in on_disk & listed.keys():
        entry = listed[name]
        manifest_path = PLUGINS_ROOT / name / ".claude-plugin" / "plugin.json"
        if not manifest_path.exists():
            continue
        manifest = _load_json(manifest_path)
        if entry.get("version") != manifest.get("version"):
            r.fail(f"version drift for {name!r}: marketplace.json={entry.get('version')!r} vs plugin.json={manifest.get('version')!r}")
        expected_source = f"./plugins/{name}"
        if entry.get("source") not in (expected_source, f"plugins/{name}"):
            r.fail(f"{name!r}: marketplace source {entry.get('source')!r} should be {expected_source!r}")
        r.ok(f"{name} @ {manifest.get('version')}")


def check_repo_version_sync(r: Reporter) -> None:
    r.section("Repo version sync")
    if not PYPROJECT.exists():
        r.fail(f"{PYPROJECT.relative_to(REPO_ROOT)}: missing")
        return

    try:
        pyproject = _load_toml(PYPROJECT)
    except tomllib.TOMLDecodeError as e:
        r.fail(f"{PYPROJECT.relative_to(REPO_ROOT)}: invalid TOML: {e}")
        return

    try:
        market = _load_json(MARKETPLACE)
    except json.JSONDecodeError:
        return

    pyproject_version = pyproject.get("project", {}).get("version")
    marketplace_version = market.get("metadata", {}).get("version")
    if pyproject_version != marketplace_version:
        r.fail(
            "repo version drift: "
            f"pyproject.toml={pyproject_version!r} vs "
            f".claude-plugin/marketplace.json metadata.version={marketplace_version!r}"
        )
        return
    r.ok(f"pyproject.toml matches marketplace metadata ({pyproject_version})")


def check_readme(r: Reporter) -> None:
    r.section("Root README <-> plugins sync")
    if not README.exists():
        r.fail("README.md: missing")
        return
    text = README.read_text(encoding="utf-8")

    for plugin_dir in _discover_plugins():
        name = plugin_dir.name
        if f"`{name}`" not in text:
            r.fail(f"README.md missing plugin entry for `{name}`")
            continue
        if f"plugins/{name}/README.md" not in text:
            r.fail(f"README.md must link to plugins/{name}/README.md")
            continue
        r.ok(f"root -> {name}")

    r.section("Per-plugin README <-> skills/agents sync")
    for plugin_dir in _discover_plugins():
        readme = plugin_dir / "README.md"
        rel = readme.relative_to(REPO_ROOT)
        if not readme.exists():
            r.fail(f"{rel}: missing - every plugin must ship a README.md")
            continue
        ptext = readme.read_text(encoding="utf-8")

        skills_dir = plugin_dir / "skills"
        if skills_dir.exists():
            for skill in sorted(s.name for s in skills_dir.iterdir() if s.is_dir()):
                if f"`{skill}`" not in ptext:
                    r.fail(f"{rel}: missing row for skill `{skill}`")
                else:
                    r.ok(f"{plugin_dir.name}/README.md -> skill {skill}")

        agents_dir = plugin_dir / "agents"
        if agents_dir.exists():
            for agent_path in sorted(agents_dir.glob("*.md")):
                agent = agent_path.stem
                if f"`{agent}`" not in ptext:
                    r.fail(f"{rel}: missing row for agent `{agent}`")
                else:
                    r.ok(f"{plugin_dir.name}/README.md -> agent {agent}")


def check_hooks(r: Reporter) -> None:
    """A plugin's hooks/hooks.json may only point at files it ships (both harnesses skip a missing one silently)."""
    r.section("Plugin hooks <-> files")
    for plugin_dir in _discover_plugins():
        hooks_json = plugin_dir / "hooks" / "hooks.json"
        if not hooks_json.exists():
            continue
        rel = hooks_json.relative_to(REPO_ROOT)
        try:
            data = _load_json(hooks_json)
        except json.JSONDecodeError as e:
            r.fail(f"{rel}: invalid JSON: {e}")
            continue
        paths = [hooks_json.parent / m for m in data.get("modules", [])]
        for groups in data.get("hooks", {}).values():
            for group in groups:
                for hook in group.get("hooks", []):
                    paths += [plugin_dir / p for p in re.findall(r"\$\{CLAUDE_PLUGIN_ROOT\}/([^\"'\s]+)", hook.get("command", ""))]
        missing = [str(p.relative_to(REPO_ROOT)) for p in paths if not p.exists()]
        if missing:
            r.fail(f"{rel}: references missing files: {', '.join(missing)}")
        else:
            r.ok(f"{plugin_dir.name}: {len(paths)} hook file(s)")


# Hook events VS Code maps (Claude PascalCase and Copilot camelCase names).
VSCODE_HOOK_EVENTS = {
    "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact",
    "SubagentStart", "SubagentStop", "Stop", "sessionStart", "sessionEnd", "userPromptSubmitted",
    "preToolUse", "postToolUse", "agentStop", "subagentStop", "errorOccurred", "ErrorOccurred",
}
KEBAB = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")


def check_vscode(r: Reporter) -> None:
    r.section("VS Code agent-plugin compatibility")
    for plugin_dir in _discover_plugins():
        errors = []
        for shadow in (".plugin/plugin.json", "plugin.json"):
            if (plugin_dir / shadow).exists():
                errors.append(f"{shadow} exists: VS Code would read it instead of .claude-plugin/plugin.json")
        for skill_md in sorted(plugin_dir.glob("skills/*/SKILL.md")):
            front = skill_md.read_text(encoding="utf-8").split("---", 2)[1]
            try:
                yaml.safe_load(front)  # Copilot CLI and VS Code parse it strictly; Claude Code does not
            except yaml.YAMLError as exc:
                errors.append(f"skills/{skill_md.parent.name}: frontmatter is not valid YAML ({str(exc).splitlines()[0]}); quote the value")
            m = re.search(r"^name:\s*[\"']?([^\"'\n]+?)[\"']?\s*$", skill_md.read_text(encoding="utf-8"), re.M)
            name = m.group(1) if m else None
            if name != skill_md.parent.name or not KEBAB.match(name):
                errors.append(f"skills/{skill_md.parent.name}: name {name!r} must be kebab-case and equal the directory")
        hooks_json = plugin_dir / "hooks" / "hooks.json"
        if hooks_json.exists():
            try:
                hooks = _load_json(hooks_json).get("hooks", {})
            except json.JSONDecodeError:
                hooks = {}  # check_hooks reports it
            errors += [f"hooks.json: event {e!r} is not one VS Code maps" for e in hooks if e not in VSCODE_HOOK_EVENTS]
            if "${CLAUDE_PLUGIN_DATA}" in hooks_json.read_text(encoding="utf-8"):
                errors.append("hooks.json: ${CLAUDE_PLUGIN_DATA} is not expanded by VS Code; read the env var in the script with a fallback")
        for e in errors:
            r.fail(f"{plugin_dir.relative_to(REPO_ROOT)}: {e}")
        if not errors:
            r.ok(plugin_dir.name)


def check_build_sync(r: Reporter) -> None:
    r.section("Generated files <-> agents/*.md, manifests and cross-plugin copies")
    result = subprocess.run(
        [sys.executable, str(REPO_ROOT / "scripts" / "build_agents.py"), "--check"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        for line in (result.stdout + result.stderr).splitlines():
            r.fail(line)
    else:
        r.ok("all agents in sync")


def check_workspace_mcp(r: Reporter) -> None:
    r.section("Workspace MCP source -> Codex and pi")
    result = subprocess.run(
        ["node", str(REPO_ROOT / "scripts" / "sync-mcp.mjs"), "--check"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        for line in (result.stdout + result.stderr).splitlines():
            r.fail(line)
    else:
        r.ok("workspace source converts without private environment values or local files")


def check_pi_package(r: Reporter) -> None:
    r.section("pi package (root package.json)")
    path = REPO_ROOT / "package.json"
    if not path.exists():
        r.fail("package.json: missing (pi installs the repo from it)")
        return
    pi = _load_json(path).get("pi", {})
    if pi.get("skills") != ["./plugins/*/skills"]:
        r.fail('package.json: pi.skills must be ["./plugins/*/skills"] so every plugin\'s skills load')
    for ext in pi.get("extensions", []):
        if not (REPO_ROOT / ext).exists():
            r.fail(f"package.json: pi extension {ext} does not exist")
    if "./plugins/guard/hooks/pi.mjs" not in pi.get("extensions", []):
        r.fail("package.json: pi.extensions must load ./plugins/guard/hooks/pi.mjs")
    else:
        r.ok("pi package loads all skills and the guard extension")


# A relative docs path, not one inside a URL or another path (`.../main/docs/x.md`).
DOCS_POINTER = re.compile(r"(?<![\w/:.-])((?:\.\./)*)docs/([\w./-]*)")
SKILL_TEXT = {".md", ".mjs", ".sh", ".ps1", ".py"}


def check_skills_self_contained(r: Reporter) -> None:
    r.section("Skills are self-contained (no pointer to this repo's docs/)")
    found = 0
    for path in sorted(p for p in PLUGINS_ROOT.glob("*/skills/**/*") if p.suffix in SKILL_TEXT):
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            for m in DOCS_POINTER.finditer(line):
                name = m.group(2).rstrip("./")
                # A file only: generic advice about a target repo's docs/wip/ must not fail here.
                if m.group(1) or (name and (REPO_ROOT / "docs" / name).is_file()):
                    found += 1
                    r.fail(f"{path.relative_to(REPO_ROOT)}:{n}: points at docs/{name}; move what the skill needs into its references/, or link https://github.com/giocaizzi/harness/blob/main/docs/{name}")
    if not found:
        r.ok("no skill file points at docs/")


def check_parity(r: Reporter) -> None:
    r.section("Parity: every skill and agent reaches every harness")
    result = subprocess.run(
        ["node", str(REPO_ROOT / "scripts" / "parity.mjs")],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        for line in (result.stdout + result.stderr).splitlines():
            r.fail(line)
    else:
        r.ok(result.stdout.strip())


def check_typescript_sync(r: Reporter) -> None:
    """Compile into a temporary directory and compare every emitted runtime file."""
    r.section("TypeScript sources <-> emitted runtime files")
    compiler = REPO_ROOT / "node_modules" / "typescript" / "bin" / "tsc"
    if not compiler.is_file() or shutil.which("node") is None:
        r.fail("TypeScript compiler or Node.js missing - run `npm ci` before validation")
        return

    with tempfile.TemporaryDirectory(prefix="harness-typescript-") as temporary:
        output = Path(temporary)
        result = subprocess.run(
            ["node", str(compiler), "--project", "tsconfig.build.json", "--outDir", str(output)],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        if result.returncode != 0:
            r.fail(f"TypeScript compilation failed:\n{result.stdout}{result.stderr}")
            return
        emitted = sorted(output.rglob("*.mjs"))
        for path in emitted:
            relative = path.relative_to(output)
            runtime = REPO_ROOT / relative
            if not runtime.is_file():
                r.fail(f"{relative}: missing TypeScript output - run `make build`")
            elif path.read_bytes() != runtime.read_bytes():
                r.fail(f"{relative}: stale TypeScript output - run `make build`")
            else:
                r.ok(str(relative))
        if not emitted:
            r.fail("TypeScript compilation emitted no runtime files")


def main() -> None:
    r = Reporter()
    check_typescript_sync(r)
    check_native_validator(r)
    check_repo_specific_manifests(r)
    check_marketplace(r)
    check_repo_version_sync(r)
    check_build_sync(r)
    check_workspace_mcp(r)
    check_hooks(r)
    check_vscode(r)
    check_pi_package(r)
    check_parity(r)
    check_skills_self_contained(r)
    check_readme(r)

    print()
    if r.errors:
        print(f"ERROR {len(r.errors)} error(s):", file=sys.stderr)
        for e in r.errors:
            print(f"  - {e}", file=sys.stderr)
        sys.exit(1)
    print("OK All checks passed.")


if __name__ == "__main__":
    main()
