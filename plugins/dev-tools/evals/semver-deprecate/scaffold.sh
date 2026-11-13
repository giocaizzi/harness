#!/usr/bin/env bash
# A small Python library at 2.3.0 exposing old_login and login.
set -euo pipefail
mkdir -p src/acme_auth
cat > pyproject.toml <<'T'
[project]
name = "acme-auth"
version = "2.3.0"
T
cat > src/acme_auth/__init__.py <<'P'
from acme_auth.session import login, old_login

__all__ = ["login", "old_login"]
P
cat > src/acme_auth/session.py <<'P'
def old_login(user, password):
    return login(user, password)


def login(user, password, *, mfa=None):
    return {"user": user, "mfa": mfa}
P
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
