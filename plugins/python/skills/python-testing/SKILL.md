---
name: python-testing
description: "pytest conventions for Python tests: fixtures vs factories, deterministic test data, TDD for bugs. Use when writing or reviewing Python tests."
---

# Python Testing

- Test behaviour, not implementation details, so refactors don't break tests. Cover edge cases and failure modes.
- TDD: tests before implementation; for bugs, reproduce with a failing test first, then fix.
- `pytest` with tests in `tests/`; `pytest-asyncio` for async; markers for categories (e.g. `@pytest.mark.integration`). Reuse shared helpers rather than duplicating them.

## Keep fixtures small

Fixture sprawl hides what a test depends on. Keep fixtures local to the test file first and promote to `conftest.py` only when reused. A fixture should depend on at most 2 others, and fixtures returning complex object graphs are out: build the graph in the test.

```python
user = make_user()
order = make_order(user)
payment = make_payment(order)
```

## Prefer factories over fixtures

A factory fixture (`user_factory(**overrides)`) lets each test state only the fields it cares about.

## Boring, deterministic data

Hardcode values unless randomness is what's under test, and use named semantic defaults (`DEFAULT_EMAIL = "user@example.com"`) so failures are reproducible and readable.

## Keep `make check` fast

`make check` gates every push and every agent stop, so a serial suite that takes tens of minutes slows all work. Run tests in parallel with `pytest -n auto` (pytest-xdist; make the tests order- and state-independent first) and keep a slow-test budget. Note the wall time of the full suite in the repo's `AGENTS.md`.

## Give every test a timeout

Use `pytest-timeout` with a per-test limit set in the pytest config (`timeout = 300` under `[tool.pytest.ini_options]`) so a hung test fails with a traceback instead of holding the CI job until the forge's job limit. Set the limit several times above the slowest legitimate test (check with `pytest --durations=15`, and remember CI runners are slower than a laptop), and raise it per test with `@pytest.mark.timeout(n)` only with a reason. Without it nothing distinguishes a stuck test from a slow suite.
