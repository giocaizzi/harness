#!/usr/bin/env bash
# Four HTTP clients that each repeat the same retry-and-log loop.
set -euo pipefail
mkdir -p src/integrations
cat > pyproject.toml <<'TOML'
[project]
name = "integrations"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = ["httpx"]
TOML
for name in orders billing shipping invoices; do
  cls="$(printf '%s' "${name:0:1}" | tr '[:lower:]' '[:upper:]')${name:1}"
  cat > "src/integrations/${name}_client.py" <<PY
import logging
import time

import httpx

log = logging.getLogger(__name__)


class ${cls}Client:
    def __init__(self, base_url: str) -> None:
        self._http = httpx.Client(base_url=base_url, timeout=5.0)

    def fetch(self, path: str) -> dict:
        for attempt in range(1, 4):
            try:
                resp = self._http.get(path)
                resp.raise_for_status()
                log.info("${name} GET %s ok on attempt %d", path, attempt)
                return resp.json()
            except httpx.HTTPError as exc:
                log.warning("${name} GET %s failed on attempt %d: %s", path, attempt, exc)
                time.sleep(2**attempt)
        raise RuntimeError("${name} GET %s failed" % path)
PY
done
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
