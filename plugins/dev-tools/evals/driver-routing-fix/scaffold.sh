#!/usr/bin/env bash
# A pager with an off-by-one in its page count and slice.
set -euo pipefail
cat > pager.py <<'PY'
def page_count(total, size):
    return total // size + 1


def page(items, number, size):
    start = number * size - size + 1
    return items[start:start + size]
PY
cat > test_pager.py <<'PY'
from pager import page


def test_first_page():
    assert page(list(range(10)), 1, 3) == [1, 2, 3]
PY
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
