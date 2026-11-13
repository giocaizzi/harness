#!/usr/bin/env bash
# A tiny repo, as the question is about the host rather than the code.
set -euo pipefail
printf '# app\n' > README.md
printf 'all:\n\t@echo ok\n' > Makefile
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
