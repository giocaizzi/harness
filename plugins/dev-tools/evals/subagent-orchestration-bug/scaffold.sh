#!/usr/bin/env bash
# A small web app that generates its session secret at startup.
set -euo pipefail
mkdir -p app
cat > app/config.py <<'P'
import secrets

SESSION_SECRET = secrets.token_hex(32)
P
cat > app/sessions.py <<'P'
import hashlib
import hmac

from app.config import SESSION_SECRET


def sign(user_id: str) -> str:
    return hmac.new(SESSION_SECRET.encode(), user_id.encode(), hashlib.sha256).hexdigest()


def verify(user_id: str, token: str) -> bool:
    return hmac.compare_digest(sign(user_id), token)
P
echo '# app' > README.md
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
