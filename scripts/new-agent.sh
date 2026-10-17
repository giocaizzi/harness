#!/usr/bin/env bash
# Scaffold a new agent: plugins/<plugin>/agents/<name>.md (Claude Code) and <name>.yaml (other harnesses).
# Usage: scripts/new-agent.sh <name> <plugin>
set -euo pipefail

name="${1:-}"
plugin="${2:-}"

if [[ -z "$name" || -z "$plugin" ]]; then
  echo "Usage: $0 <name> <plugin>" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
agents_dir="$repo_root/plugins/$plugin/agents"

if [[ ! -d "$repo_root/plugins/$plugin" ]]; then
  echo "Error: plugin '$plugin' does not exist (looked for $repo_root/plugins/$plugin)" >&2
  exit 1
fi

if [[ -e "$agents_dir/$name.md" ]]; then
  echo "Error: plugins/$plugin/agents/$name.md already exists" >&2
  exit 1
fi

mkdir -p "$agents_dir"

cat > "$agents_dir/$name.md" <<EOF
---
name: $name
description: TODO. Use when ...
tools: Read, Edit, Bash, Grep, Glob, WebSearch
model: sonnet
---

# Role

Describe the agent role and behaviour here.
EOF

cat > "$agents_dir/$name.yaml" <<'EOF'
# Overrides for the harnesses that do not read the .md as-is (make build).
copilot:
  tools:
    - read
    - edit
    - execute
    - search
EOF

echo "Created plugins/$plugin/agents/$name.md and $name.yaml."
echo "Next: edit both, then run \`make build\`."
