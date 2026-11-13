#!/usr/bin/env bash
# A Python package measured by pytest-cov with coverage at 78 percent.
set -euo pipefail
mkdir -p src/tally tests
cat > pyproject.toml <<'T'
[project]
name = "tally"
version = "0.1.0"
requires-python = ">=3.12"

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["src"]
T
cat > Makefile <<'T'
.PHONY: test check
test:
	uv run pytest --cov=tally --cov-report=term-missing
check: test
T
cat > src/tally/__init__.py <<'T'
def total(items: list[int]) -> int:
    return sum(items)


def average(items: list[int]) -> float:
    if not items:
        raise ValueError("empty")
    return total(items) / len(items)


def median(items: list[int]) -> float:
    ordered = sorted(items)
    mid = len(ordered) // 2
    return ordered[mid] if len(ordered) % 2 else (ordered[mid - 1] + ordered[mid]) / 2
T
cat > tests/test_tally.py <<'T'
from tally import average, total


def test_total():
    assert total([1, 2, 3]) == 6


def test_average():
    assert average([2, 4]) == 3
T
cat > COVERAGE.txt <<'T'
Last CI run: TOTAL 78%
T
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
