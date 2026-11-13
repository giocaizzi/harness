#!/usr/bin/env bash
# A small Python service whose job queue uses Redis.
set -euo pipefail
mkdir -p jobs
cat > jobs/queue.py <<'P'
import json

import redis

r = redis.Redis(host="localhost")


def enqueue(name, payload):
    r.rpush("jobs", json.dumps({"name": name, "payload": payload}))


def dequeue():
    raw = r.blpop("jobs", timeout=5)
    return json.loads(raw[1]) if raw else None
P
cat > jobs/worker.py <<'P'
from jobs.queue import dequeue


def run():
    while (job := dequeue()) is not None:
        print("running", job["name"])
P
printf 'redis\npsycopg\n' > requirements.txt
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
