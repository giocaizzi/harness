#!/usr/bin/env bash
# Scaffold a new agent source tree under src/agents/<name>/.
# Usage: scripts/new-agent.sh <name> <plugin>
set -euo pipefail

name="${1:-}"
plugin="${2:-}"

if [[ -z "$name" || -z "$plugin" ]]; then
  echo "Usage: $0 <name> <plugin>" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
src_dir="$repo_root/src/agents/$name"
plugin_dir="$repo_root/plugins/$plugin"

if [[ ! -d "$plugin_dir" ]]; then
  echo "Error: plugin '$plugin' does not exist (looked for $plugin_dir)" >&2
  exit 1
fi

if [[ -d "$src_dir" ]]; then
  echo "Error: src/agents/$name already exists" >&2
  exit 1
fi

mkdir -p "$src_dir"

cat > "$src_dir/agent.yaml" <<EOF
name: $name
description: TODO. Use when ...
plugin: $plugin
model: sonnet
EOF

cat > "$src_dir/claude.yaml" <<'EOF'
tools: Read, Edit, Bash, Grep, Glob, WebSearch
EOF

cat > "$src_dir/copilot.yaml" <<'EOF'
tools:
  - read
  - edit
  - execute
  - search
EOF

cat > "$src_dir/body.md" <<'EOF'
# Role

Describe the agent role and behaviour here.
EOF

echo "Created src/agents/$name/ for plugin '$plugin'."
echo "Next: edit the four files, then run \`make build\`."
