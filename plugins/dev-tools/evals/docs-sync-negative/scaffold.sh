#!/usr/bin/env bash
# A tiny Python module with a paginate function and no documentation.
set -euo pipefail
mkdir -p src
cat > src/pages.py <<'PY'
def paginate(items: list, per_page: int) -> list[list]:
    # Split items into pages of at most per_page items.
    pages = []
    for start in range(0, len(items) - per_page, per_page):
        pages.append(items[start:start + per_page])
    return pages
PY
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
