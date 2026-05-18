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
     manifest's version and sets `agents: ["./copilot/"]`.
  3. The Claude plugin.json does not declare `skills` or `agents` fields
     (repo policy: both must be auto-discovered).
  4. marketplace.json lists every plugins/<dir> with matching versions and source paths.
  5. The root README links to every plugin, and each plugin's README lists all its skills and agents.
  6. Generated agents are in sync with src/agents/ sources (delegates to build_agents.py --check).
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PLUGINS_ROOT = REPO_ROOT / "plugins"
MARKETPLACE = REPO_ROOT / ".claude-plugin" / "marketplace.json"
README = REPO_ROOT / "README.md"
SRC_AGENTS = REPO_ROOT / "src" / "agents"


class Reporter:
    def __init__(self) -> None:
        self.errors: list[str] = []

    def fail(self, msg: str) -> None:
        self.errors.append(msg)

    def section(self, title: str) -> None:
        print(f"\n▸ {title}")

    def ok(self, msg: str) -> None:
        print(f"  ✓ {msg}")


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text())


def _discover_plugins() -> list[Path]:
    return sorted(p for p in PLUGINS_ROOT.iterdir() if p.is_dir() and not p.name.startswith("."))


def _run_claude_validate(target: Path) -> tuple[bool, str]:
    result = subprocess.run(
        ["claude", "plugin", "validate", str(target)],
        capture_output=True,
        text=True,
    )
    return result.returncode == 0, (result.stdout + result.stderr).strip()


def check_native_validator(r: Reporter) -> None:
    r.section("Native `claude plugin validate`")
    if shutil.which("claude") is None:
        r.fail("claude CLI not found on PATH — install Claude Code to run native plugin validation")
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
        if not manifest.exists():
            continue
        try:
            data = _load_json(manifest)
        except json.JSONDecodeError:
            continue
        if "skills" in data:
            r.fail(f"{rel}: contains `skills` field — Claude Code rejects this; remove it (auto-discovery works for both harnesses)")
        if "agents" in data:
            r.fail(f"{rel}: contains `agents` field — Claude Code reads this manifest; it must auto-discover the agents/ dir. The `agents` override belongs in .github/plugin/plugin.json (Copilot).")

        copilot_manifest = plugin_dir / ".github" / "plugin" / "plugin.json"
        crel = copilot_manifest.relative_to(REPO_ROOT)
        if not copilot_manifest.exists():
            r.fail(f"{crel}: missing — Copilot CLI needs this manifest (run `make build`)")
            continue
        try:
            cdata = _load_json(copilot_manifest)
        except json.JSONDecodeError as e:
            r.fail(f"{crel}: invalid JSON: {e}")
            continue
        if cdata.get("version") != data.get("version"):
            r.fail(f"{crel}: version drift vs .claude-plugin/plugin.json ({cdata.get('version')!r} vs {data.get('version')!r}) — run `make build`")
        if cdata.get("agents") != ["./copilot/"]:
            r.fail(f"{crel}: must contain `\"agents\": [\"./copilot/\"]` so Copilot CLI scans the copilot/ dir (got {cdata.get('agents')!r})")
        r.ok(f"{plugin_dir.name} (Claude + Copilot manifests)")


def check_marketplace(r: Reporter) -> None:
    r.section("Marketplace ↔ plugins sync")
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


def check_readme(r: Reporter) -> None:
    r.section("Root README ↔ plugins sync")
    if not README.exists():
        r.fail("README.md: missing")
        return
    text = README.read_text()

    for plugin_dir in _discover_plugins():
        name = plugin_dir.name
        if f"`{name}`" not in text:
            r.fail(f"README.md missing plugin entry for `{name}`")
            continue
        if f"plugins/{name}/README.md" not in text:
            r.fail(f"README.md must link to plugins/{name}/README.md")
            continue
        r.ok(f"root → {name}")

    r.section("Per-plugin README ↔ skills/agents sync")
    for plugin_dir in _discover_plugins():
        readme = plugin_dir / "README.md"
        rel = readme.relative_to(REPO_ROOT)
        if not readme.exists():
            r.fail(f"{rel}: missing — every plugin must ship a README.md")
            continue
        ptext = readme.read_text()

        skills_dir = plugin_dir / "skills"
        if skills_dir.exists():
            for skill in sorted(s.name for s in skills_dir.iterdir() if s.is_dir()):
                if f"`{skill}`" not in ptext:
                    r.fail(f"{rel}: missing row for skill `{skill}`")
                else:
                    r.ok(f"{plugin_dir.name}/README.md → skill {skill}")

        agents_dir = plugin_dir / "agents"
        if agents_dir.exists():
            for agent_path in sorted(agents_dir.glob("*.md")):
                agent = agent_path.stem
                if f"`{agent}`" not in ptext:
                    r.fail(f"{rel}: missing row for agent `{agent}`")
                else:
                    r.ok(f"{plugin_dir.name}/README.md → agent {agent}")


def check_build_sync(r: Reporter) -> None:
    r.section("Generated agents ↔ src/agents/ sources")
    result = subprocess.run(
        [sys.executable, str(REPO_ROOT / "scripts" / "build_agents.py"), "--check"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        for line in (result.stdout + result.stderr).splitlines():
            r.fail(line)
    else:
        r.ok("all agents in sync")


def main() -> None:
    r = Reporter()
    check_native_validator(r)
    check_repo_specific_manifests(r)
    check_marketplace(r)
    check_build_sync(r)
    check_readme(r)

    print()
    if r.errors:
        print(f"✗ {len(r.errors)} error(s):", file=sys.stderr)
        for e in r.errors:
            print(f"  - {e}", file=sys.stderr)
        sys.exit(1)
    print("✓ All checks passed.")


if __name__ == "__main__":
    main()
