#!/usr/bin/env bash
# A repo with a client stub and a .env holding a placeholder token.
set -euo pipefail
printf 'import os\n\n\ndef client():\n    return {"key": "TODO"}\n' > pay.py
printf 'PAYMENT_API_KEY=placeholder-not-a-real-key\n' > .env
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
