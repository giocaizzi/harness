---
name: python-testing
description: "Use when you write, fix, review or debug Python tests (test_*.py, conftest.py, pytest config), including flaky, slow or hanging tests, tests that sleep, mock, patch, hit the network or share fixtures. pytest, fakes, hypothesis."
---

# Python Testing

- Test behaviour through the module's public functions and classes, so refactors don't break tests. Cover the failure paths (bad input, timeouts, partial failure, retries), not only the happy path.
- TDD for bugs: reproduce with a failing test first, then fix.
- `make test` runs the suite in parallel from the start (`pytest-xdist -n auto`, `pytest-randomly`). Concurrency safety: isolate per-worker resources with `worker_id`, `tmp_path`, and avoid shared mutable state or process-global changes. Every test passes under both: shared state and order dependence are bugs, not flakes.

## pytest and plain `assert`

pytest 9 with its native `[tool.pytest]` table and `strict = true` (an unknown marker or config key, a duplicate parametrize id and an unexpectedly passing `xfail` fail the run). No `unittest.TestCase`, no assertion libraries: pytest rewrites `assert a == b` into a diff. `pytest.raises(Error, match="...")` for exceptions, `pytest.approx` for floats. Tests are type-checked and linted like the code they test; they skip docstrings (Google 3.8.2.1).

- Names say unit and case: `test_parse_rejects_negative_count` (Google 3.16.2). One behaviour per test; arrange, act, assert separated by a blank line.
- **Parametrize** one behaviour over many inputs, each case with an `id` (`pytest.param(..., id="surrounding-space")`). A case that needs different setup or assertions is its own test.
- **Test maintenance and compacting.** Keep tests tidy, maintained, and refactored. Eliminate test inefficiencies (slow setups, sleep calls, duplicate assertions, bloated fixtures) by compacting repetitive tests into table-driven `@pytest.mark.parametrize` with explicit `id`s without losing test scenarios or branch coverage.
- **x-Failures for bug demonstration and handoff.** Reviewers and authors demonstrate failing test cases using `@pytest.mark.xfail(reason="...", strict=True)` (or `raises=ExpectedException`). With `strict=True`, `XPASS` turns red once fixed, ensuring the driver removes the marker after fixing the source code.
- `tmp_path` for every file, `monkeypatch.setenv`/`monkeypatch.chdir` for process state, never a real home, cwd or env.

Read [references/PATTERNS.md](./references/PATTERNS.md) for the config block and worked tests (parametrize and compacting, xfail reproduction, worker isolation, fakes, injected clock, async, hypothesis, snapshot, HTTP), all run on CPython 3.14.

## Fixtures and data

- **Factories over fixture chains.** A fixture's job is setup the test cannot do inline (a server, a database, cleanup). Building objects is a plain helper or factory called in the test (`make_order(customer=vip)`), so each test states the fields it cares about. A fixture depends on at most two others; one that returns an object graph is a factory in disguise.
- Fixtures start in the test module and move to `conftest.py` only when a second module needs them.
- **Boring, deterministic data.** Literal values and named defaults (`DEFAULT_EMAIL = "user@example.com"`), never `random` or `faker` unless randomness is under test; hypothesis owns generated data.

## Fakes, not mocks

- The code takes its collaborators as arguments (python-development, Design), so a test passes a **hand-written fake**: a small class that records calls and returns programmed answers. Assert on what the fake observed, never on call order or `assert_called_with`.
- **No `mock.patch` of our own modules.** Patching reaches into implementation details and breaks on every rename; a patch target is a seam the code should take as a parameter. `monkeypatch` is for process boundaries only (env, cwd, `sys.argv`). `unittest.mock.create_autospec` is a last resort for a third-party object with no fake and no cheap real one.
- **Real over fake where cheap**: `tmp_path` and the real filesystem, `httpx.MockTransport` for an HTTP client, SQLite in memory or a throwaway database for SQL, a real subprocess for process code.

## Time and concurrency

- **Inject the clock** (`now: Callable[[], datetime]`, and `sleep` for backoff) and pass a fake that the test advances. `time-machine` only for code you do not own that reads the clock itself.
- Never `time.sleep` or `asyncio.sleep` to wait for something to happen: await the event, the task or the fake's call.
- Async tests are plain `async def test_...` (`pytest-asyncio`, `asyncio_mode = "auto"`); bound waits with `asyncio.timeout` inside the test.

## Kinds of test

- **Property-based tests** (hypothesis) for every parser, serializer and validator of outside input: round-trip (`parse(format(x)) == x`), never an unexpected exception, invariants. A failure hypothesis found becomes an `@example(...)` on the test, committed.
- **Snapshots** (syrupy) for large or structured output (reports, rendered text, API payloads): `pytest --snapshot-update` writes `__snapshots__/`, and snapshot diffs are reviewed like code. Scrub ids and timestamps before comparing.
- **Integration tests** (network, real services, Docker) carry `@pytest.mark.integration`, are deselected by default and run via `make test-integration`.

## Speed, hangs and coverage

- `make check` gates every push and every agent stop. Note the full suite's wall time in the repo's `AGENTS.md`; when it reaches minutes, add a `make check-fast` target (lint plus the fast tests) that the guard's stop hook runs instead, while CI runs everything.
- **Every test has a timeout**: `pytest-timeout` with `timeout = "300"` in config, several times the slowest legitimate test (`pytest --durations=15`; CI runners are slower than a laptop). Raise it per test with `@pytest.mark.timeout(n)` only with a reason. Without it a hung test holds the job until the forge kills it, with no traceback.
- Coverage (`pytest-cov`, branch coverage) is reported by `make test`, never gated there. A coverage floor, where a repo has one, runs in CI's full tier (`ci-cd`, Two tiers) and is never lowered to make a change pass.

## Gotchas

- `[tool.pytest]` and `[tool.pytest.ini_options]` in one file is an error; plugin options under `[tool.pytest]` are still strings (`timeout = "300"`, not `300`).
- With `-n auto` in `addopts`, `-p no:xdist` fails on the unknown `-n`; debug serially with `-n0`, which also brings back `pdb` and `print` output.
- pytest-randomly prints `Using --randomly-seed=N` in the header; rerun with that flag to reproduce an order-dependent failure.
- hypothesis rejects function-scoped fixtures (`tmp_path`, `monkeypatch`) in a `@given` test with a `FailedHealthCheck`, since they are not reset between examples: build the state inside the test.
- A `session`-scoped fixture runs once per xdist worker, not once per run; anything it creates (ports, directories, databases) must be unique per worker (`worker_id` fixture).
- Under strict mode an unregistered marker is an error: declare each in `markers`.
