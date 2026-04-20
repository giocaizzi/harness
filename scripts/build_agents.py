#!/usr/bin/env python3
"""Generate dual-format agent files from source.

Source layout (edit here):
  agents/<name>/body.md             shared system prompt
  agents/<name>/copilot.yaml        Copilot CLI frontmatter fields
  agents/<name>/claude.yaml         Claude Code frontmatter fields (may include 'plugin: <name>')

Plugin routing convention:
  The target plugin is resolved from 'plugin: <name>' in claude.yaml if present,
  otherwise derived from the first segment of the agent dir name before '-'.
  Example: 'api-reviewer' -> plugin 'api' -> plugins/api/agents/

Generated output (do not edit):
  plugins/<plugin>/agents/<name>.md          Claude Code format
  plugins/<plugin>/copilot/<name>.agent.md   Copilot CLI format
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    yaml = None  # type: ignore[assignment]

REPO_ROOT = Path(__file__).parent.parent
AGENTS_ROOT = REPO_ROOT / "agents"
PLUGINS_ROOT = REPO_ROOT / "plugins"


def _render(frontmatter_yaml: str, body: str) -> str:
    return f"---\n{frontmatter_yaml.strip()}\n---\n\n{body.strip()}\n"


def _resolve_plugin(name: str, claude_fm: str) -> str:
    """Resolve target plugin: 'plugin:' field in claude.yaml, else first '-' segment."""
    if yaml is not None:
        data = yaml.safe_load(claude_fm) or {}
        if "plugin" in data:
            return str(data["plugin"])
    else:
        for line in claude_fm.splitlines():
            if line.startswith("plugin:"):
                return line.split(":", 1)[1].strip()
    return name.split("-")[0]


def build_agent(name: str, *, check: bool = False) -> bool:
    src = AGENTS_ROOT / name
    missing = [f for f in ("body.md", "copilot.yaml", "claude.yaml") if not (src / f).exists()]
    if missing:
        print(f"ERROR: {name}: missing source files: {missing}", file=sys.stderr)
        return False

    body = (src / "body.md").read_text()
    copilot_fm = (src / "copilot.yaml").read_text()
    claude_fm = (src / "claude.yaml").read_text()

    plugin = _resolve_plugin(name, claude_fm)
    plugin_dir = PLUGINS_ROOT / plugin

    targets = {
        plugin_dir / "agents" / f"{name}.md": _render(claude_fm, body),
        plugin_dir / "copilot" / f"{name}.agent.md": _render(copilot_fm, body),
    }

    ok = True
    for out_path, content in targets.items():
        if check:
            if not out_path.exists() or out_path.read_text() != content:
                print(f"  OUT OF SYNC: {out_path.relative_to(REPO_ROOT)}", file=sys.stderr)
                ok = False
        else:
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_text(content)
            print(f"  written: {out_path.relative_to(REPO_ROOT)}")
    return ok


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="Validate generated files are up to date (exit 1 if not)")
    args = parser.parse_args()

    agents = sorted(
        d.name for d in AGENTS_ROOT.iterdir()
        if d.is_dir() and not d.name.startswith(".")
        and (d / "body.md").exists()
    )
    if not agents:
        print(f"ERROR: no agents found in {AGENTS_ROOT}", file=sys.stderr)
        sys.exit(1)

    verb = "Checking" if args.check else "Building"
    print(f"{verb} {len(agents)} agent(s): {', '.join(agents)}")

    ok = all(build_agent(name, check=args.check) for name in agents)

    if args.check:
        if ok:
            print("All agent files are up to date.")
        else:
            print("\nRun `make build` to regenerate.", file=sys.stderr)
            sys.exit(1)


if __name__ == "__main__":
    main()
