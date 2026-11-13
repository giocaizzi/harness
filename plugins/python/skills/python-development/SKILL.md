---
name: python-development
description: "Use when you write or change Python (.py), pyproject.toml or a ruff config: a feature, fix, refactor, review or scaffold, even when the user does not mention conventions. Python 3.14, uv, ruff, mypy --strict."
---

# Python Development (3.14+)

Baseline: the [Google Python Style Guide](https://google.github.io/styleguide/pyguide.html); the rules below add to it and never relax it. Where a tool enforces a rule, its config is the spec: don't restate it in code review, fix the finding.

The floor is the oldest CPython release still in bugfix support, so new code gets binary installers and every interpreter fix: 3.14 while 3.15 is current (3.13 went security-only in October 2026). `requires-python = ">=3.14"`; applications run the current release (`uv python pin 3.15`). A published library may reach down to the oldest security-supported release when its users need it, testing every version it claims in CI.

## Tooling

- **uv for everything**: `uv add`, `uv sync`, `uv run`, `uvx` for one-off CLIs. Never pip, pipx or global installs: they bypass the lockfile. Each worktree's `.venv` links from uv's shared cache (cheap on the same filesystem); never point `UV_CACHE_DIR` into the repo (`host-hygiene`, Shared stores). Dev tools live in `[dependency-groups]` (PEP 735), never in an `[project.optional-dependencies]` extra users can install. Commit `uv.lock` (list it in release-please `extra-files`: see the `release-please` skill). Build backend `uv_build`, `src/<package>/` layout.
- **A single-file script** declares its dependencies inline (PEP 723, `uv add --script tool.py httpx`) and runs with `uv run tool.py`; its shebang stays `#!/usr/bin/env python3` (Google 3.7).
- **ruff, every rule on**: copy [references/ruff.toml](./references/ruff.toml) to the repo root and keep no `[tool.ruff]` table. It encodes every Google rule a linter can check (80 columns, Google docstrings, no relative imports, one import per line, logging with `%` args) and ignores a rule only with the reason inline. ruff stands in for Google's pylint; silence one finding with `# noqa: CODE  # reason`.
- **mypy `--strict` is the gate** (Google asks for "a type checking tool like pyrefly"; any checker complies). Configure it in `[tool.mypy]` with `strict = true`, `files = ["src", "tests"]`, the `explicit-override` and `ignore-without-code` error codes, and `plugins = ["pydantic.mypy"]` when Pydantic is a dependency. Suppress with `# type: ignore[code]  # reason`, never bare. A repo already on pyright or pyrefly keeps it.
- **The editor and the agent's LSP run pyright**, a different engine: use it to navigate (definitions, references, hover) and treat its diagnostics as hints. `make lint` (mypy) decides. ty (Astral) would be one engine for both; switch when it has a strict mode and reaches 1.0.
- **Make is the command surface**: `help`, `fmt`, `lint` (lockfile, format, ruff, mypy; changes nothing), `test`, `check` (= `lint` + `test`). One predictable surface lets humans, CI and agents run the same checks; add the targets when a repo lacks them.

Read [references/PROJECT_STRUCTURE.md](./references/PROJECT_STRUCTURE.md) when scaffolding: layout, `pyproject.toml`, Makefile, CI, scripts, workspaces (the pipeline itself: `ci-cd`; on GitHub, `github-actions`).

## Imports

- **Import modules, never their members** (Google 2.2): `from shop import orders`, then `orders.Order(...)`; `import datetime as dt` only for a standard abbreviation. Symbols from `typing`, `collections.abc` and `typing_extensions` are the exception and are imported by name. Absolute always.
- **`__init__.py` holds a docstring, nothing else.** No re-exports: they invite `from shop import Order`, and their import cost hits every user of the package.
- **Lazy imports** (PEP 810, 3.15) cut a CLI's start-up: `lazy import heavy_module` at the top of the module, never a function-level import. On the 3.14 floor list them in `__lazy_modules__ = ["heavy_module"]` above the imports instead; 3.14 ignores it, 3.15 makes those imports lazy.

## Typing

- Annotate every function, method and non-obvious variable (stricter than Google, which asks for public APIs). Parameters take the widest type the code supports (`Sequence`, `Mapping`, `Iterable`); returns the narrowest concrete type.
- PEP 695 syntax: `class Stack[T]`, `def first[T](items: Sequence[T]) -> T`, `type Alias = ...`, `X | None`. A `type` statement is the alias declaration Google 3.19.6 asks for: CapWords, `_Private` when module-local. A PEP 695 type parameter is scoped to its function or class, so a single letter meets Google's naming exemption; a bounded or constrained one gets a descriptive name (`[AddableT: (int, str)]`).
- Annotations are evaluated lazily since 3.14 (PEP 649/749): no `from __future__ import annotations` and no quoted forward references; delete both when the floor reaches 3.14.
- `@override` on every override (mypy's `explicit-override` enforces it, dunders such as `__str__` included; the override then needs no docstring, Google 3.8.3.1). `TypeIs` over `TypeGuard`. `TYPE_CHECKING` imports only to break a cycle (Google 3.19.13).
- No `Any`, `cast` or ignore without a one-line reason: they silence the checker instead of fixing the model.

Read [references/TYPING.md](./references/TYPING.md) for the version table, protocols, overloads, `ParamSpec` decorators, TypedDict and `typing_extensions`.

## Design

- **Abstract late.** Extract a shared function on the third copy, not the second. No `Protocol` or ABC for a single implementation unless a test needs the seam; the second implementation introduces it, declared next to the code that consumes it.
- **Name a class for what it is** (`SlackSender`, `PriceTable`), never for a pattern (`*Factory`, `*Manager`, `*Helper`, `*Util`, `Abstract*`, `Base*`) unless the class is that pattern and nothing else.
- **Modules by feature, not by technical kind**: `billing.py`, `notifications/`, never `models/`, `services/`, `utils/`, `helpers.py`. A module holds the related classes and functions together (Google 3.16.2). A project on the `domain-driven-design` skill's layers keeps them, with features inside each.
- **Composition and constructor injection.** Collaborators (clients, clocks, senders) are constructor parameters; `main()` builds them and passes them down. No DI framework, no service locator, no module-level client or singleton (Google 2.5). Inherit only for framework hooks, exceptions and shallow hierarchies you own.
- Classes hold state plus behaviour; stateless transforms are module functions. No `@staticmethod`; `@classmethod` only as a named constructor (`Interval.parse`) (Google 2.17). `@property` only for a cheap computed value, never a plain getter or setter (Google 2.13).
- **Values are `@dataclass(frozen=True, slots=True)`**, `kw_only=True` past two fields; outside input is validated at the boundary into Pydantic models or dataclasses; never a raw `dict` for structured data, whose shape the checker cannot see.
- Optional parameters are keyword-only (`def fetch(url, *, timeout=5.0)`). An executable module has `main(argv: Sequence[str] | None = None) -> int` behind `if __name__ == "__main__": sys.exit(main())`, which is also the `[project.scripts]` entry point.
- Architecture across modules (layers, repositories, ports and adapters, use cases) is the `domain-driven-design` skill's (foundations plugin): load it for that, not this. Python's layout and wiring for it: [references/HEXAGONAL.md](./references/HEXAGONAL.md).

## Errors

- Built-in exceptions for misuse (`ValueError` for a bad argument, Google 2.4); one package base (`class Error(Exception)` in `shop/errors.py`, so callers write `errors.Error`, never `shop.ShopError`) for conditions callers handle. Messages state the condition with the value: `f"Not a percentage: {percent=}"` (Google 3.10.2).
- Catch narrowly. `except Exception` only to re-raise or at an isolation point (a worker's outermost loop, a request handler) that logs with `_LOGGER.exception`. Chain with `raise New(...) from exc`; add context with `exc.add_note(...)`.
- `with` for every resource; `asyncio.TaskGroup` and `except*` for concurrent failures; `assert` only in tests.

## Concurrency and the standard library

- I/O-bound: `asyncio` with `TaskGroup` and `asyncio.timeout`. CPU-bound: `concurrent.futures.InterpreterPoolExecutor` (3.14; one interpreter, and one GIL, per worker) or `ProcessPoolExecutor`. The free-threaded build (supported since 3.14, PEP 779) only when every dependency ships for it and the suite runs on it in CI. Threads share data through `queue.Queue` or a lock, never through the atomicity of built-ins (Google 2.18).
- Logging: `_LOGGER = logging.getLogger(__name__)`, `%` arguments, never an f-string (Google 3.10.1); `print` only in a CLI's output path.
- Template strings (`t"..."`, PEP 750) for SQL, HTML or shell text built from values, passed to a function that escapes each interpolation; never an f-string there.
- `pathlib` over `os.path`, `StrEnum` over string constants, `encoding="utf-8"` on every text `open` while the floor is 3.14 (UTF-8 is the default only from 3.15, PEP 686).

Read [references/PATTERNS.md](./references/PATTERNS.md) for the program skeleton, one seam with its fake, an adapter and the package's errors, values, concurrent failures and t-strings, as code. Read [references/REVIEW.md](./references/REVIEW.md) when reviewing Python: the Google rules no tool checks.

## Gotchas

- `uv pip install` is still pip: it changes the environment without touching `pyproject.toml` or `uv.lock`, so the next `uv sync` undoes it. Use `uv add`.
- `uv init` writes `requires-python` from the newest interpreter it finds (`>=3.15`); set it back to the floor.
- A `ruff.toml` beside `pyproject.toml` wins outright: a `[tool.ruff]` table in `pyproject.toml` is then silently ignored.
- ruff's logging rules find loggers by name: `_LOGGER` and `logger` are checked, `_LOG` is not.
- Run mypy through `uv run`, never `uvx mypy`: it must see the project's environment, or every third-party import is missing and the Pydantic plugin does not load.
- pyright and mypy disagree at the edges (Pydantic coercion, narrowing, overloads): when the LSP flags code that `make lint` passes, mypy wins; don't contort code for the hint.
- `lazy import` is a `SyntaxError` before 3.15, even under a version check; use `__lazy_modules__` on the 3.14 floor.
- On 3.14 reading `obj.__annotations__` evaluates them and raises `NameError` for a name only imported under `TYPE_CHECKING`; introspect with `annotationlib.get_annotations(obj, format=annotationlib.Format.FORWARDREF)`.
- A Pydantic model resolves its annotations at runtime, so a field type imported only under `TYPE_CHECKING` leaves it "not fully defined". Import model field types for real.
- In an existing repo its own ruff, type checker and layout win: don't switch on `select = ["ALL"]`, `strict = true` or Google imports in a change that is about something else; propose that as its own change.
