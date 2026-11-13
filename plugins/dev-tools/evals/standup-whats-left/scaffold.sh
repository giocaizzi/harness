#!/usr/bin/env bash
# A tiny repo with a STATE.md describing work in progress.
set -euo pipefail
cat > STATE.md <<'MD'
# State: search rewrite

Goal: replace the SQL LIKE search with a full-text index.
Done: schema migration merged (PR 31); indexer job written.
In progress: query endpoint, PR 33, checks failing on one test.
Not started: relevance tuning, docs.
Needs a decision: keep the old endpoint for one release or remove it now?
MD
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
