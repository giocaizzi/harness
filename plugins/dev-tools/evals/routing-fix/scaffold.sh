#!/usr/bin/env bash
# A search package with an off-by-one in its pager.
set -euo pipefail
mkdir -p search tests
cat > search/pager.py <<'PY'
def page_count(total, size):
    return total // size + 1


def page(items, number, size):
    """Return page `number` (1-based) of `items`."""
    start = number * size - size + 1
    return items[start:start + size]
PY
cat > search/index.py <<'PY'
from search.pager import page, page_count


class Index:
    def __init__(self, docs):
        self.docs = sorted(docs, key=lambda d: d["score"], reverse=True)

    def query(self, term):
        return [d for d in self.docs if term in d["text"]]

    def results(self, term, number, size=10):
        hits = self.query(term)
        return {"page": number, "pages": page_count(len(hits), size), "items": page(hits, number, size)}
PY
cat > search/api.py <<'PY'
from search.index import Index


def search_handler(index: Index, params):
    number = int(params.get("page", 1))
    size = int(params.get("size", 10))
    return index.results(params["q"], number, size)
PY
cat > tests/test_index.py <<'PY'
from search.index import Index


def test_query_filters():
    idx = Index([{"text": "a b", "score": 1}, {"text": "c", "score": 2}])
    assert [d["text"] for d in idx.query("a")] == ["a b"]
PY
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
