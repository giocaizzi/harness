#!/usr/bin/env bash
# A Python package with an async fetch_all and no tests.
set -euo pipefail
cat > pyproject.toml <<'TOML'
[project]
name = "acme"
version = "0.1.0"
requires-python = ">=3.14"
dependencies = ["httpx"]

[tool.mypy]
strict = true

[tool.pytest.ini_options]
testpaths = ["tests"]
TOML
mkdir -p src/acme tests
cat > src/acme/fetcher.py <<'PY'
import asyncio
from collections.abc import Awaitable, Callable

Fetch = Callable[[str], Awaitable[str]]


async def fetch_all(urls: list[str], fetch: Fetch, limit: int = 5) -> dict[str, str]:
    sem = asyncio.Semaphore(limit)

    async def one(url: str) -> tuple[str, str]:
        async with sem:
            return url, await fetch(url)

    pairs = await asyncio.gather(*(one(u) for u in urls))
    return dict(pairs)
PY
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
