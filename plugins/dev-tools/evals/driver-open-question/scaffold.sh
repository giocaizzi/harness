#!/usr/bin/env bash
# A local-only notes app: storage and sync are open design choices.
set -euo pipefail
cat > notes.py <<'PY'
import json
from pathlib import Path

STORE = Path.home() / ".notes.json"


def save(notes):
    STORE.write_text(json.dumps(notes))


def load():
    return json.loads(STORE.read_text()) if STORE.exists() else []
PY
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
