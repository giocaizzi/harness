#!/usr/bin/env bash
# A uv package whose retry test sleeps for real and patches the module under test.
set -euo pipefail
mkdir -p src/fetcher tests
cat > pyproject.toml <<'TOML'
[project]
name = "fetcher"
version = "0.1.0"
requires-python = ">=3.14"

[dependency-groups]
dev = ["pytest>=9.2"]
TOML
cat > src/fetcher/__init__.py <<'PY'
"""Fetches with retries."""
PY
cat > src/fetcher/backoff.py <<'PY'
"""Retries a call with exponential backoff."""

from collections.abc import Callable
import time


def retry[T](call: Callable[[], T], *, attempts: int = 4, base: float = 0.5) -> T:
    """Calls until it succeeds, sleeping base, 2*base, ... between tries.

    Args:
        call: The operation.
        attempts: Tries before the last error propagates.
        base: First delay in seconds.

    Returns:
        The call's result.
    """
    for attempt in range(attempts - 1):
        try:
            return call()
        except ConnectionError:
            time.sleep(base * 2**attempt)
    return call()
PY
cat > tests/test_backoff.py <<'PY'
import time
from unittest import mock

from fetcher import backoff


def test_retry_eventually_succeeds():
    calls = []

    def flaky():
        calls.append(time.monotonic())
        if len(calls) < 3:
            raise ConnectionError
        return "ok"

    start = time.monotonic()
    assert backoff.retry(flaky) == "ok"
    assert 1.4 < time.monotonic() - start < 1.6


def test_retry_gives_up():
    with mock.patch("fetcher.backoff.time.sleep"):
        failing = mock.Mock(side_effect=ConnectionError)
        try:
            backoff.retry(failing)
        except ConnectionError:
            pass
        failing.assert_has_calls([mock.call()] * 4)
PY
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
