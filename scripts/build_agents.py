#!/usr/bin/env python3
"""Generate dual-harness plugin artifacts.

For every agent in src/agents/<name>/ the script writes:
  plugins/<plugin>/agents/<name>.md          ← Claude Code agent (.md)
  plugins/<plugin>/copilot/<name>.agent.md   ← Copilot CLI agent (.agent.md)

For every plugin in plugins/<plugin>/ with .claude-plugin/plugin.json the script writes:
  plugins/<plugin>/.github/plugin/plugin.json   ← Copilot manifest, derived from the
                                                  Claude one, with `agents: ["./copilot/"]`
                                                  added so Copilot scans the copilot/ dir.

Why two locations?
  Claude scans agents/ for any *.md (including *.agent.md), so Copilot files MUST live
  outside agents/ or Claude double-loads them. Copilot's plugin.json discovery prefers
  .github/plugin/ over .claude-plugin/, so each harness reads its own manifest.

Agent source layout:
  src/agents/<name>/agent.yaml      shared frontmatter (name, description, plugin, model)
  src/agents/<name>/body.md         shared system prompt
  src/agents/<name>/claude.yaml     Claude-only overrides (optional)
  src/agents/<name>/copilot.yaml    Copilot-only overrides (optional)
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC_AGENTS = REPO_ROOT / "src" / "agents"
PLUGINS_ROOT = REPO_ROOT / "plugins"


# --------------------------------------------------------------------------- agents


def _load_yaml(path: Path) -> dict:
    if not path.exists():
        return {}
    data = yaml.safe_load(path.read_text()) or {}
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected a YAML mapping, got {type(data).__name__}")
    return data


def _resolve_plugin(name: str, shared: dict) -> str:
    plugin = shared.get("plugin")
    return str(plugin) if plugin else name.split("-", 1)[0]


def _render(frontmatter: dict, body: str) -> str:
    fm = yaml.safe_dump(
        frontmatter,
        sort_keys=False,
        default_flow_style=False,
        allow_unicode=True,
        width=10_000,
    ).strip()
    return f"---\n{fm}\n---\n\n{body.strip()}\n"


def _build_agent(name: str, *, check: bool) -> bool:
    src = SRC_AGENTS / name
    if not (src / "agent.yaml").exists() or not (src / "body.md").exists():
        print(f"ERROR: {name}: agent.yaml and body.md are required in {src.relative_to(REPO_ROOT)}", file=sys.stderr)
        return False

    shared = _load_yaml(src / "agent.yaml")
    claude_overrides = _load_yaml(src / "claude.yaml")
    copilot_overrides = _load_yaml(src / "copilot.yaml")
    body = (src / "body.md").read_text()

    if shared.get("name") != name:
        print(f"ERROR: {name}: agent.yaml `name` ({shared.get('name')!r}) must match dir name", file=sys.stderr)
        return False
    if "description" not in shared:
        print(f"ERROR: {name}: agent.yaml is missing required `description`", file=sys.stderr)
        return False

    plugin = _resolve_plugin(name, shared)
    plugin_dir = PLUGINS_ROOT / plugin
    if not plugin_dir.exists():
        print(f"ERROR: {name}: plugin {plugin!r} does not exist (expected {plugin_dir.relative_to(REPO_ROOT)})", file=sys.stderr)
        return False

    base = {k: v for k, v in shared.items() if k != "plugin"}
    claude_fm = {**base, **claude_overrides}
    copilot_fm = {**base, **copilot_overrides}

    targets = {
        plugin_dir / "agents" / f"{name}.md": _render(claude_fm, body),
        plugin_dir / "copilot" / f"{name}.agent.md": _render(copilot_fm, body),
    }

    ok = True
    for path, content in targets.items():
        rel = path.relative_to(REPO_ROOT)
        if check:
            if not path.exists() or path.read_text() != content:
                print(f"  OUT OF SYNC: {rel}", file=sys.stderr)
                ok = False
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
            print(f"  written: {rel}")
    return ok


# --------------------------------------------------------------------------- manifests


def _build_copilot_manifest(plugin_dir: Path, *, check: bool) -> bool:
    claude_manifest = plugin_dir / ".claude-plugin" / "plugin.json"
    copilot_manifest = plugin_dir / ".github" / "plugin" / "plugin.json"
    if not claude_manifest.exists():
        print(f"ERROR: {claude_manifest.relative_to(REPO_ROOT)}: missing (cannot derive Copilot manifest)", file=sys.stderr)
        return False

    data = json.loads(claude_manifest.read_text())
    copilot_data = {**data, "agents": ["./copilot/"]}
    content = json.dumps(copilot_data, indent=2) + "\n"

    rel = copilot_manifest.relative_to(REPO_ROOT)
    if check:
        if not copilot_manifest.exists() or copilot_manifest.read_text() != content:
            print(f"  OUT OF SYNC: {rel}", file=sys.stderr)
            return False
    else:
        copilot_manifest.parent.mkdir(parents=True, exist_ok=True)
        copilot_manifest.write_text(content)
        print(f"  written: {rel}")
    return True


# --------------------------------------------------------------------------- main


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="Exit 1 if generated files are out of sync.")
    args = parser.parse_args()

    if not SRC_AGENTS.exists():
        print(f"ERROR: source dir not found: {SRC_AGENTS}", file=sys.stderr)
        sys.exit(1)

    agents = sorted(
        d.name for d in SRC_AGENTS.iterdir()
        if d.is_dir() and not d.name.startswith(".") and (d / "agent.yaml").exists()
    )
    plugins = sorted(
        p for p in PLUGINS_ROOT.iterdir()
        if p.is_dir() and not p.name.startswith(".") and (p / ".claude-plugin" / "plugin.json").exists()
    )

    verb = "Checking" if args.check else "Building"
    print(f"{verb} {len(agents)} agent(s): {', '.join(agents) or '(none)'}")
    ok_agents = all(_build_agent(n, check=args.check) for n in agents)

    print(f"{verb} {len(plugins)} Copilot manifest(s): {', '.join(p.name for p in plugins) or '(none)'}")
    ok_manifests = all(_build_copilot_manifest(p, check=args.check) for p in plugins)

    if not (ok_agents and ok_manifests):
        if args.check:
            print("\nRun `make build` to regenerate.", file=sys.stderr)
        sys.exit(1)

    if args.check:
        print("All generated files are up to date.")


if __name__ == "__main__":
    main()
