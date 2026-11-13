#!/usr/bin/env bash
# A library at 1.3.0 plus an added public function.
set -euo pipefail
printf 'def request(url):\n    return url\n' > lib.py
printf '[project]\nname = "lib"\nversion = "1.3.0"\n' > pyproject.toml
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
printf 'def request(url):\n    return url\n\n\ndef request_json(url):\n    return {"url": url}\n' > lib.py
printf '[project]\nname = "lib"\nversion = "1.3.1"\n' > pyproject.toml
git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm "bump version"
