#!/usr/bin/env python3
"""Generate the per-harness plugin artifacts.

Agents are authored in place, as the Claude Code file, with an optional sidecar for the other harnesses:
  plugins/<plugin>/agents/<name>.md      Claude Code agent: frontmatter + system prompt (authored)
  plugins/<plugin>/agents/<name>.yaml    optional `copilot:`, `codex:`, `opencode:` override mappings (authored)

Claude Code and VS Code read agents/*.md as-is. From each one the script writes:
  plugins/<plugin>/.generated/copilot/<name>.agent.md   Copilot CLI agent: name, description + copilot overrides
  plugins/<plugin>/.generated/codex/<name>.toml         Codex custom agent, installed by scripts/install.mjs
  plugins/<plugin>/.generated/opencode/<name>.md        opencode subagent, installed by scripts/install.mjs

The other harnesses get only `name`/`description` from the Claude file: its `tools`, `effort` and `model` are
Claude values (a `model` names a Claude tier), so they inherit the session's unless their override sets one.

For every plugin in plugins/<plugin>/ with .claude-plugin/plugin.json the script writes:
  plugins/<plugin>/.github/plugin/plugin.json       Copilot manifest: the Claude one plus
                                                    `agents: ["./.generated/copilot/"]`.
  plugins/<plugin>/.codex-plugin/plugin.json        Codex manifest; with hooks, it points Codex at
  plugins/<plugin>/.generated/codex/hooks.json      hooks.json without the Claude `modules` key (Codex rejects
                                                    the file otherwise), the guard run with `--no-ask` (Codex
                                                    has no ask), every script with `--harness=codex` (its
                                                    telemetry label), SessionEnd at Codex's 3 s cap, plus the Codex-only hooks of
                                                    hooks/codex-only.json.

Files one plugin's hooks run from another (plugins install separately, so a hook cannot import across them):
  plugins/guard/.generated/factory/check-result.mjs  factory's result checker, for guard's result gate on stop.

Everything generated lives in a dot-folder, so every visible file under plugins/<plugin>/ is authored.
Copilot files stay out of agents/: Claude loads any *.md there, including *.agent.md.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import tomllib

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
PLUGINS_ROOT = REPO_ROOT / "plugins"
GENERATED = ".generated"
HARNESS_KEYS = ("copilot", "codex", "opencode")


# --------------------------------------------------------------------------- agents


def _load_yaml(path: Path) -> dict:
    if not path.exists():
        return {}
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected a YAML mapping, got {type(data).__name__}")
    return data


def _parse(path: Path) -> tuple[dict, str]:
    m = re.match(r"^---\r?\n(.*?)\r?\n---\r?\n(.*)$", path.read_text(encoding="utf-8"), re.S)
    if not m:
        raise ValueError(f"{path}: expected YAML frontmatter between --- lines")
    fm = yaml.safe_load(m.group(1)) or {}
    if not isinstance(fm, dict):
        raise ValueError(f"{path}: frontmatter must be a YAML mapping")
    return fm, m.group(2)


def _render(frontmatter: dict, body: str) -> str:
    fm = yaml.safe_dump(
        frontmatter,
        sort_keys=False,
        default_flow_style=False,
        allow_unicode=True,
        width=10_000,
    ).strip()
    return f"---\n{fm}\n---\n\n{body.strip()}\n"


def _render_toml(data: dict) -> str:
    # JSON string escapes are valid TOML basic-string escapes; tomllib round-trips the result as a check.
    def value(v: object) -> str:
        if isinstance(v, bool):
            return "true" if v else "false"
        if isinstance(v, (int, float)):
            return str(v)
        if isinstance(v, str):
            return json.dumps(v, ensure_ascii=False)
        raise ValueError(f"unsupported TOML value: {v!r}")

    out = "".join(f"{k} = {value(v)}\n" for k, v in data.items())
    if tomllib.loads(out) != data:
        raise ValueError("TOML round-trip mismatch")
    return out


def _build_agent(path: Path, *, check: bool) -> bool:
    name = path.stem
    rel = path.relative_to(REPO_ROOT)
    claude, body = _parse(path)
    overrides = _load_yaml(path.with_suffix(".yaml"))

    if claude.get("name") != name:
        print(f"ERROR: {rel}: `name` ({claude.get('name')!r}) must match the file name", file=sys.stderr)
        return False
    if "description" not in claude:
        print(f"ERROR: {rel}: missing required `description`", file=sys.stderr)
        return False
    if unknown := set(overrides) - set(HARNESS_KEYS):
        print(f"ERROR: {rel.with_suffix('.yaml')}: unknown keys {sorted(unknown)}; expected {', '.join(HARNESS_KEYS)}", file=sys.stderr)
        return False
    copilot_overrides, codex_overrides, opencode_overrides = (overrides.get(k) or {} for k in HARNESS_KEYS)

    base = {"name": name, "description": claude["description"]}
    copilot_fm = {**base, **copilot_overrides}
    codex = {**base, **codex_overrides, "developer_instructions": body.strip() + "\n"}
    opencode_fm = {"description": claude["description"], "mode": "subagent", **opencode_overrides}

    out = path.parent.parent / GENERATED
    targets = {
        out / "copilot" / f"{name}.agent.md": _render(copilot_fm, body),
        out / "codex" / f"{name}.toml": _render_toml(codex),
        out / "opencode" / f"{name}.md": _render(opencode_fm, body),
    }
    return all([_sync(p, content, check=check) for p, content in targets.items()])


# --------------------------------------------------------------------------- manifests


def _sync(path: Path, content: str, *, check: bool) -> bool:
    rel = path.relative_to(REPO_ROOT)
    if check:
        if not path.exists() or path.read_text(encoding="utf-8") != content:
            print(f"  OUT OF SYNC: {rel}", file=sys.stderr)
            return False
        return True
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    print(f"  written: {rel}")
    return True


def _build_codex(plugin_dir: Path, *, check: bool) -> bool:
    data = json.loads((plugin_dir / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8"))
    hooks_file = plugin_dir / "hooks" / "hooks.json"
    ok = True
    if hooks_file.exists():
        hooks = json.loads(hooks_file.read_text(encoding="utf-8"))
        codex_hooks = {k: v for k, v in hooks.items() if k != "modules"}
        codex_hooks.setdefault("hooks", {})
        for event, groups in codex_hooks["hooks"].items():
            for group in groups:
                for hook in group.get("hooks", []):
                    # Codex clamps a SessionEnd hook to 3 s (and warns on every run); ask for what it gives.
                    if event == "SessionEnd" and hook.get("timeout", 0) > 3:
                        hook["timeout"] = 3
                    if "/hooks/guard.mjs" in hook.get("command", ""):
                        hook["command"] += " --no-ask"
                    # The scripts cannot tell Codex from Claude Code by environment (both set CLAUDE_PLUGIN_*).
                    if hook.get("command", "").startswith("node "):
                        hook["command"] += " --harness=codex"
        codex_only = plugin_dir / "hooks" / "codex-only.json"
        if codex_only.exists():
            for event, groups in json.loads(codex_only.read_text(encoding="utf-8"))["hooks"].items():
                codex_hooks["hooks"].setdefault(event, []).extend(groups)
        ok = _sync(plugin_dir / GENERATED / "codex" / "hooks.json", json.dumps(codex_hooks, indent=2) + "\n", check=check)
        data = {**data, "hooks": f"./{GENERATED}/codex/hooks.json"}
    return _sync(plugin_dir / ".codex-plugin" / "plugin.json", json.dumps(data, indent=2) + "\n", check=check) and ok


def _build_copilot_manifest(plugin_dir: Path, *, check: bool) -> bool:
    claude_manifest = plugin_dir / ".claude-plugin" / "plugin.json"
    copilot_manifest = plugin_dir / ".github" / "plugin" / "plugin.json"
    if not claude_manifest.exists():
        print(f"ERROR: {claude_manifest.relative_to(REPO_ROOT)}: missing (cannot derive Copilot manifest)", file=sys.stderr)
        return False

    data = json.loads(claude_manifest.read_text(encoding="utf-8"))
    copilot_data = {**data, "agents": [f"./{GENERATED}/copilot/"]}
    return _sync(copilot_manifest, json.dumps(copilot_data, indent=2) + "\n", check=check)


# --------------------------------------------------------------------------- cross-plugin copies

# (source, copy), relative to plugins/.
COPIES = (("factory/skills/ticket-run/scripts/check-result.mjs", "guard/.generated/factory/check-result.mjs"),)


def _build_copies(*, check: bool) -> bool:
    ok = True
    for source, copy in COPIES:
        header = f"// GENERATED by scripts/build_agents.py from plugins/{source}; never edit.\n"
        content = header + (PLUGINS_ROOT / source).read_text(encoding="utf-8")
        ok = _sync(PLUGINS_ROOT / copy, content, check=check) and ok
    return ok


# --------------------------------------------------------------------------- main


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="Exit 1 if generated files are out of sync.")
    args = parser.parse_args()

    plugins = sorted(
        p for p in PLUGINS_ROOT.iterdir()
        if p.is_dir() and not p.name.startswith(".") and (p / ".claude-plugin" / "plugin.json").exists()
    )

    agents = sorted(p for plugin in plugins for p in (plugin / "agents").glob("*.md"))

    verb = "Checking" if args.check else "Building"
    print(f"{verb} {len(agents)} agent(s): {', '.join(p.stem for p in agents) or '(none)'}")
    ok_agents = all([_build_agent(p, check=args.check) for p in agents])

    print(f"{verb} {len(plugins)} Copilot manifest(s): {', '.join(p.name for p in plugins) or '(none)'}")
    ok_manifests = all(_build_copilot_manifest(p, check=args.check) for p in plugins)

    print(f"{verb} {len(plugins)} Codex manifest(s)")
    ok_manifests = all(_build_codex(p, check=args.check) for p in plugins) and ok_manifests

    print(f"{verb} {len(COPIES)} cross-plugin copy(ies)")
    ok_manifests = _build_copies(check=args.check) and ok_manifests

    if not (ok_agents and ok_manifests):
        if args.check:
            print("\nRun `make build` to regenerate.", file=sys.stderr)
        sys.exit(1)

    if args.check:
        print("All generated files are up to date.")


if __name__ == "__main__":
    main()
