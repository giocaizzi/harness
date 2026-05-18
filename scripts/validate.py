#!/usr/bin/env python3
"""Validate repo invariants for the dual-harness plugin layout.

Checks:
  1. Every plugin has .claude-plugin/plugin.json with valid metadata.
  2. No plugin.json declares a `skills` field (Claude Code rejects it).
  3. Each SKILL.md has frontmatter conforming to the agentskills.io spec.
  4. marketplace.json lists every plugins/<dir>, with versions matching plugin.json.
  5. The root README links to every plugin, and each plugin's README lists all its skills and agents.
  6. Generated agents are in sync with src/agents/ sources (delegates to build_agents.py --check).
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
PLUGINS_ROOT = REPO_ROOT / "plugins"
MARKETPLACE = REPO_ROOT / ".claude-plugin" / "marketplace.json"
README = REPO_ROOT / "README.md"
SRC_AGENTS = REPO_ROOT / "src" / "agents"

SKILL_NAME_RE = re.compile(r"^(?!-)(?!.*--)[a-z0-9-]{1,64}(?<!-)$")
PLUGIN_NAME_RE = re.compile(r"^(?!-)(?!.*--)[a-z0-9-]{1,64}(?<!-)$")


class Reporter:
    def __init__(self) -> None:
        self.errors: list[str] = []

    def fail(self, msg: str) -> None:
        self.errors.append(msg)

    def section(self, title: str) -> None:
        print(f"\n▸ {title}")

    def ok(self, msg: str) -> None:
        print(f"  ✓ {msg}")


def _load_yaml_frontmatter(path: Path) -> dict | None:
    text = path.read_text()
    if not text.startswith("---\n"):
        return None
    end = text.find("\n---", 4)
    if end < 0:
        return None
    return yaml.safe_load(text[4:end]) or {}


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text())


def _discover_plugins() -> list[Path]:
    return sorted(p for p in PLUGINS_ROOT.iterdir() if p.is_dir() and not p.name.startswith("."))


def check_plugin_manifests(r: Reporter) -> None:
    r.section("Plugin manifests")
    for plugin_dir in _discover_plugins():
        manifest = plugin_dir / ".claude-plugin" / "plugin.json"
        rel = manifest.relative_to(REPO_ROOT)
        if not manifest.exists():
            r.fail(f"{rel}: missing")
            continue
        try:
            data = _load_json(manifest)
        except json.JSONDecodeError as e:
            r.fail(f"{rel}: invalid JSON: {e}")
            continue
        if data.get("name") != plugin_dir.name:
            r.fail(f"{rel}: name {data.get('name')!r} must match dir name {plugin_dir.name!r}")
        if not PLUGIN_NAME_RE.match(plugin_dir.name):
            r.fail(f"{rel}: dir name {plugin_dir.name!r} is not valid kebab-case")
        if "version" not in data:
            r.fail(f"{rel}: missing `version`")
        if "skills" in data:
            r.fail(f"{rel}: contains `skills` field — Claude Code rejects this; remove it (auto-discovery works for both harnesses)")
        if "agents" in data:
            r.fail(f"{rel}: contains `agents` field — Claude Code reads this manifest; it must auto-discover the agents/ dir. The `agents` override belongs in .github/plugin/plugin.json (Copilot).")
        r.ok(f"{plugin_dir.name} @ {data.get('version', '?')}")

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


def check_skills(r: Reporter) -> None:
    r.section("Skills (agentskills.io spec)")
    for plugin_dir in _discover_plugins():
        skills_dir = plugin_dir / "skills"
        if not skills_dir.exists():
            continue
        for skill_dir in sorted(p for p in skills_dir.iterdir() if p.is_dir()):
            skill_md = skill_dir / "SKILL.md"
            rel = skill_md.relative_to(REPO_ROOT)
            if not skill_md.exists():
                r.fail(f"{rel}: missing SKILL.md")
                continue
            fm = _load_yaml_frontmatter(skill_md)
            if fm is None:
                r.fail(f"{rel}: missing YAML frontmatter")
                continue
            name = fm.get("name")
            if name != skill_dir.name:
                r.fail(f"{rel}: frontmatter `name` ({name!r}) must match dir {skill_dir.name!r}")
            if name and not SKILL_NAME_RE.match(str(name)):
                r.fail(f"{rel}: `name` {name!r} violates agentskills.io regex")
            desc = fm.get("description", "")
            if not isinstance(desc, str) or not desc.strip():
                r.fail(f"{rel}: `description` is required and must be non-empty")
            elif len(desc) > 1024:
                r.fail(f"{rel}: `description` exceeds 1024 chars ({len(desc)})")
            r.ok(f"{plugin_dir.name}/{skill_dir.name}")


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
    check_plugin_manifests(r)
    check_skills(r)
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
