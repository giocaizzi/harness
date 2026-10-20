#!/usr/bin/env bash
# A tiny repo with an uncommitted change on a feature branch.
set -euo pipefail
echo "# app" > README.md
git init -q -b feat/usage && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
echo "Run with `app --help`." >> README.md
