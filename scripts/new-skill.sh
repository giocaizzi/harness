#!/usr/bin/env bash
# Scaffold a new skill under plugins/<plugin>/skills/<name>/.
# Usage: scripts/new-skill.sh <plugin> <name>
set -euo pipefail

plugin="${1:-}"
name="${2:-}"

if [[ -z "$plugin" || -z "$name" ]]; then
  echo "Usage: $0 <plugin> <name>" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
plugin_dir="$repo_root/plugins/$plugin"
skill_dir="$plugin_dir/skills/$name"

if [[ ! -d "$plugin_dir" ]]; then
  echo "Error: plugin '$plugin' does not exist (looked for $plugin_dir)" >&2
  exit 1
fi

if [[ -d "$skill_dir" ]]; then
  echo "Error: $skill_dir already exists" >&2
  exit 1
fi

mkdir -p "$skill_dir"

cat > "$skill_dir/SKILL.md" <<EOF
---
name: $name
description: TODO. Use when ...
---

Skill content here.
EOF

echo "Created plugins/$plugin/skills/$name/SKILL.md."
echo "Next: edit the description (10–1024 chars, agent-triggering phrase) and the body."
echo "Then bump the plugin version and update README.md, then run \`make validate\`."
