#!/usr/bin/env bash
# A local dev script; the branch adds a --quiet flag.
set -euo pipefail
mkdir -p tools tests
cat > tools/lint_todo.py <<'PY'
import argparse, pathlib


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("root", nargs="?", default=".")
    a = p.parse_args(argv)
    hits = [f for f in pathlib.Path(a.root).rglob("*.py") if "TODO" in f.read_text()]
    for f in hits:
        print(f)
    return 0
PY
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
git checkout -qb feat/quiet-flag
cat > tools/lint_todo.py <<'PY'
import argparse, pathlib


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("root", nargs="?", default=".")
    p.add_argument("--quiet", action="store_true", help="print only the count")
    a = p.parse_args(argv)
    hits = [f for f in pathlib.Path(a.root).rglob("*.py") if "TODO" in f.read_text()]
    if a.quiet:
        print(len(hits))
        return 0
    for f in hits:
        print(f)
    return 0
PY
cat > tests/test_lint_todo.py <<'PY'
from tools.lint_todo import main


def test_quiet(tmp_path, capsys):
    (tmp_path / "a.py").write_text("# TODO")
    main([str(tmp_path), "--quiet"])
    assert capsys.readouterr().out.strip() == "1"
PY
git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm "feat(tools): add --quiet to lint_todo"
git checkout -q main
