#!/usr/bin/env bash
# A service repo with a Dockerfile and no release tool.
set -euo pipefail
printf 'FROM python:3.13-slim\nCOPY app.py .\nCMD ["python", "app.py"]\n' > Dockerfile
printf 'print("api")\n' > app.py
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
