#!/usr/bin/env bash
# An app with config.yaml, a loader and a configuration doc that mentions the key.
set -euo pipefail
mkdir -p app docs
cat > config.yaml <<'YML'
host: 0.0.0.0
port: 8080
timeout: 30
YML
touch app/__init__.py
cat > app/config.py <<'PY'
import yaml


def load(path: str = "config.yaml") -> dict:
    with open(path) as f:
        raw = yaml.safe_load(f)
    return {
        "host": raw["host"],
        "port": raw["port"],
        "timeout": raw["timeout"],
    }
PY
cat > docs/configuration.md <<'MD'
# Configuration

`config.yaml` keys:

| Key | Default | Meaning |
|---|---|---|
| `host` | `0.0.0.0` | Interface to bind |
| `port` | `8080` | Port to listen on |
| `timeout` | `30` | Request timeout in seconds |
MD
printf '# app\n' > README.md
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
