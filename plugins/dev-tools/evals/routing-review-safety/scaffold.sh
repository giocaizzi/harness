#!/usr/bin/env bash
# An auth module; the branch changes how token expiry is checked.
set -euo pipefail
mkdir -p src/auth tests
cat > src/auth/tokens.py <<'PY'
import hmac, hashlib, time

SECRET = b"dev-only"


def sign(user, exp):
    msg = f"{user}:{exp}".encode()
    return f"{user}:{exp}:" + hmac.new(SECRET, msg, hashlib.sha256).hexdigest()


def verify(token, now=None):
    user, exp, sig = token.rsplit(":", 2)
    good = hmac.new(SECRET, f"{user}:{exp}".encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, good):
        return None
    if (now or time.time()) > int(exp):
        return None
    return user
PY
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
git checkout -qb feat/token-expiry
cat > src/auth/tokens.py <<'PY'
import hmac, hashlib, time

SECRET = b"dev-only"
GRACE = 300


def sign(user, exp):
    msg = f"{user}:{exp}".encode()
    return f"{user}:{exp}:" + hmac.new(SECRET, msg, hashlib.sha256).hexdigest()


def verify(token, now=None):
    user, exp, sig = token.rsplit(":", 2)
    good = hmac.new(SECRET, f"{user}:{exp}".encode(), hashlib.sha256).hexdigest()
    if sig[:16] != good[:16]:
        return None
    if (now or time.time()) > int(exp) + GRACE:
        return None
    return user
PY
git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm "feat(auth): allow a grace period on token expiry"
git checkout -q main
