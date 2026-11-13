#!/usr/bin/env bash
# A small service whose startup logs the full DATABASE_URL.
set -euo pipefail
mkdir -p app
touch app/__init__.py
cat > app/main.py <<'PY'
import logging
import os

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("app")


def connect(url):
    return {"url": url}


def main():
    database_url = os.environ["DATABASE_URL"]
    log.info("starting with DATABASE_URL=%s", database_url)
    return connect(database_url)


if __name__ == "__main__":
    main()
PY
echo "# acme-svc" > README.md
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
