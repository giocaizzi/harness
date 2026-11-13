#!/usr/bin/env bash
# A GitLab monorepo with six services and one test job per service.
set -euo pipefail
for s in a b c d e f; do
  mkdir -p services/$s
  printf 'def test_ok():\n    assert True\n' > services/$s/test_service.py
  printf 'print("service %s")\n' "$s" > services/$s/main.py
done
{
  echo 'stages: [test]'
  echo
  for s in a b c d e f; do
    cat <<YML
test-$s:
  stage: test
  image: python:3.13
  script:
    - cd services/$s
    - pip install pytest
    - pytest

YML
  done
} > .gitlab-ci.yml
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
