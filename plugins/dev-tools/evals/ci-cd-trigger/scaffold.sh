#!/usr/bin/env bash
# A GitLab pipeline whose stages run one after another although the jobs share nothing.
set -euo pipefail
cat > .gitlab-ci.yml <<'YML'
stages: [lint, unit, integration, build]
lint:
  stage: lint
  script: [make lint]
unit:
  stage: unit
  script: [make test-unit]
integration:
  stage: integration
  script: [make test-integration]
build:
  stage: build
  script: [make build]
YML
printf 'lint:\n\truff check .\ntest-unit:\n\tpytest tests/unit\ntest-integration:\n\tpytest tests/integration\nbuild:\n\tuv build\n' > Makefile
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
