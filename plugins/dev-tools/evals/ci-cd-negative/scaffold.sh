#!/usr/bin/env bash
# A Go module with a Makefile; the prompt is about a local target, not CI.
set -euo pipefail
printf 'module example.com/app\n\ngo 1.26\n' > go.mod
printf 'package main\n\nfunc main() {}\n' > main.go
printf 'test:\n\tgo test ./...\n' > Makefile
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
