#!/usr/bin/env bash
# Three request handlers that each contain the same copied validation.
set -euo pipefail
mkdir -p src/users
cat > src/users/handlers.py <<'T'
def create_user(body: dict) -> dict:
    email = body.get("email", "").strip().lower()
    if "@" not in email or len(email) > 254:
        raise ValueError("invalid email")
    return {"email": email, "role": "member"}


def invite_user(body: dict) -> dict:
    email = body.get("email", "").strip().lower()
    if "@" not in email or len(email) > 254:
        raise ValueError("invalid email")
    return {"email": email, "invited": True}


def update_email(user: dict, body: dict) -> dict:
    email = body.get("email", "").strip().lower()
    if "@" not in email or len(email) > 254:
        raise ValueError("invalid email")
    user["email"] = email
    return user
T
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
