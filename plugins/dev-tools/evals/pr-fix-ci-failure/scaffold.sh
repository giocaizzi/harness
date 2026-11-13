#!/usr/bin/env bash
# A feature branch with a workflow file; GitHub is unreachable.
set -euo pipefail
mkdir -p .github/workflows
printf 'name: ci\non: [pull_request]\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: make check\n' > .github/workflows/ci.yml
printf 'check:\n\tpython -m pytest\n' > Makefile
printf 'def double(x):\n    return x * 2\n' > m.py
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
git checkout -q -b feat/double
