#!/usr/bin/env bash
# A report tool with a data model and a text-only CLI.
set -euo pipefail
mkdir -p src/report tests
: > src/report/__init__.py
cat > src/report/model.py <<'PY'
from dataclasses import dataclass


@dataclass
class Row:
    name: str
    count: int
    total: float


def sample():
    return [Row("apples", 3, 4.5), Row("pears", 1, 2.0)]
PY
cat > src/report/cli.py <<'PY'
import sys

from report.model import sample


def main(argv=None):
    for r in sample():
        print(f"{r.name}\t{r.count}\t{r.total:.2f}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
PY
printf '[pytest]\npythonpath = src\n' > pytest.ini
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
