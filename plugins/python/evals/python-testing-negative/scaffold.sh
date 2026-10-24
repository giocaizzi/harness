#!/usr/bin/env bash
# A uv word-count CLI with a test suite.
set -euo pipefail
mkdir -p src/wordcount tests
cat > pyproject.toml <<'TOML'
[project]
name = "wordcount"
version = "0.1.0"
requires-python = ">=3.12"

[project.scripts]
wordcount = "wordcount.cli:main"
TOML
cat > src/wordcount/__init__.py <<'PY'
PY
cat > src/wordcount/cli.py <<'PY'
import argparse
from pathlib import Path


def count_words(path: Path) -> int:
    return len(path.read_text().split())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="wordcount")
    parser.add_argument("files", nargs="+", type=Path)
    args = parser.parse_args(argv)
    total = sum(count_words(p) for p in args.files)
    print(total)
    return 0
PY
cat > tests/test_cli.py <<'PY'
from wordcount.cli import count_words


def test_count_words(tmp_path):
    f = tmp_path / "a.txt"
    f.write_text("one two three")
    assert count_words(f) == 3
PY
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
