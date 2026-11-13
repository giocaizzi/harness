#!/usr/bin/env bash
# A GitLab project with a two-job pipeline and a Makefile.
set -euo pipefail
cat > .gitlab-ci.yml <<'YML'
stages: [test]

lint:
  stage: test
  image: python:3.14
  script:
    - make lint

test:
  stage: test
  image: python:3.14
  script:
    - make test
YML
cat > Makefile <<'MK'
lint:
	ruff check .

test:
	python3 -m pytest
MK
echo "# acme-svc" > README.md
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
