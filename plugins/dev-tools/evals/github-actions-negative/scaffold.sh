#!/usr/bin/env bash
# A Python repo on GitLab CI; no GitHub workflow exists.
set -euo pipefail
cat > .gitlab-ci.yml <<'YML'
test:
  image: python:3.14
  script: [pip install uv, uv run pytest]
YML
printf '[project]\nname = "app"\nversion = "0.1.0"\n' > pyproject.toml
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
