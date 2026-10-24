#!/usr/bin/env bash
# Eight services that log through a deprecated module.
set -euo pipefail
mkdir -p services lib
cat > lib/legacy_log.py <<'PY'
"""Deprecated: positional, unstructured logging with a global level."""
import sys, time

LEVEL = "info"


def _emit(level, msg, *args):
    sys.stderr.write(f"{time.time():.0f} {level.upper()} " + (msg % args if args else msg) + "\n")


def info(msg, *args):
    _emit("info", msg, *args)


def warn(msg, *args):
    _emit("warn", msg, *args)


def error(msg, *args):
    _emit("error", msg, *args)
PY
for s in auth billing search media notify orders inventory gateway; do
  mkdir -p services/$s
  cat > services/$s/main.py <<PY
from lib import legacy_log as log
from services.$s import handlers


def run(config):
    log.info("$s starting on port %s", config["port"])
    try:
        handlers.serve(config)
    except Exception as exc:
        log.error("$s crashed: %s", exc)
        raise
PY
  cat > services/$s/handlers.py <<PY
from lib import legacy_log as log


def serve(config):
    for route in config.get("routes", []):
        log.info("$s route %s registered", route)
    if config.get("debug"):
        log.warn("$s running in debug mode")


def handle(request):
    log.info("$s request %s %s", request["method"], request["path"])
    if request.get("user") is None:
        log.warn("$s anonymous request to %s", request["path"])
    return {"status": 200}
PY
done
cat > README.md <<'MD'
# platform

Eight services under services/, each deployed on its own. They log through lib/legacy_log.py, which is deprecated.
MD
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
