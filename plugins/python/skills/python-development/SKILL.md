---
name: python-development
description: python development best practices and conventions. Use this skill whenever you are developing Python code. You must follow these guidelines always.
---

# Python Development (3.12+)

Modern Python development guidelines targeting **3.12 as minimum**, with version-specific features noted.
References provide deep dives: [typing](./references/TYPING.md) · [project structure](./references/PROJECT_STRUCTURE.md) · [patterns](./references/PATTERNS.md)

## Version-Specific Features

Use these features when the project's minimum Python version allows:

| Feature | Min version | Notes |
|---|---|---|
| `class Foo[T]`, `def bar[T]()` (PEP 695) | 3.12 | New generic syntax; replaces `TypeVar` + `Generic` |
| `type Alias = ...` keyword (PEP 695) | 3.12 | Replaces `TypeAlias` assignment |
| `X \| Y` union syntax in annotations | 3.10 | Always use (3.12+ is our floor) |
| `@override` decorator | 3.12 | Mark methods that override a parent |
| `TypeIs` (PEP 742) | 3.13 | Preferred over `TypeGuard` |
| `@warnings.deprecated` (PEP 702) | 3.13 | Standard deprecation decorator |
| `ReadOnly` TypedDict fields (PEP 705) | 3.13 | Immutable TypedDict keys |
| `TypeVar` defaults (PEP 696) | 3.13 | `T = TypeVar("T", default=int)` |
| Deferred annotation eval (PEP 649) | 3.14 | No quoting/`__future__` needed |
| `except` without parens (PEP 758) | 3.14 | `except ValueError, TypeError:` |
| Template strings `t"..."` (PEP 750) | 3.14 | Structured string interpolation |

For features above the project minimum, use `typing_extensions` as a runtime polyfill.

## Project Setup

- Single source of truth: `pyproject.toml` (metadata, deps, tool config)
- Package manager: **`uv`** (preferred) or `poetry`
- Layout: `src/` layout — `src/<package>/` for importable code
- Lock deps: `uv.lock` committed to VCS
- See [project structure reference](./references/PROJECT_STRUCTURE.md) for details

## Typing

- Type hints on **all** functions, methods, and module-level variables
- `X | None` — never `Union` or `Optional`
- Generic syntax: `class Foo[T]: ...` / `def bar[T](x: T) -> T: ...` (3.12+)
- Type aliases: `type Vector = list[float]` (3.12+)
- Forward references: use `from __future__ import annotations` on 3.12–3.13; unnecessary on 3.14+
- `TYPE_CHECKING` only for: circular import avoidance or annotation-only imports
- Prefer `Protocol` for structural typing; `TypeIs` over `TypeGuard` (3.13+)
- Parameters: widest type the implementation supports (`Sequence` not `list`, `Mapping` not `dict`)
- Returns: narrowest concrete type
- See [typing reference](./references/TYPING.md) for protocols, generics, overloads, and advanced patterns

### Prohibited

- `Any` (use `object` + `isinstance` or generics)
- `typing.cast`, `# type: ignore` (unless unavoidable with justification comment)
- Mutable default arguments
- Untyped `*args`/`**kwargs`
- Legacy `typing.List`, `typing.Dict`, `typing.Tuple`, `typing.Optional`, `typing.Union`

## Code Style

- **Composition over inheritance** — inject dependencies, don't subclass
- Single responsibility: one reason to change per class/function
- Classes for state + behavior; plain functions for stateless transforms
- `@dataclass(slots=True)` or Pydantic `BaseModel` for data (never raw dicts for structured data)
- Meaningful names; no abbreviations; verb-prefix for functions (`get_`, `create_`, `is_`)
- Docstrings on all public API (Google style); omit for obvious private helpers
- Keyword-only params for optionals: `def f(x: int, *, timeout: float = 5.0)`
- See [patterns reference](./references/PATTERNS.md) for design patterns and error handling

## Imports

- Relative imports (`.module`) within the same top-level package
- Absolute imports for everything else (cross-package, stdlib, external)
- Group order: stdlib → third-party → local (enforced by `ruff`)
- No wildcard imports (`from module import *`)

## Error Handling

- Raise specific exceptions; never bare `raise Exception(...)`
- Custom exceptions inherit `Exception` with names ending in `Error`
- Catch narrowly: specific types only, never bare `except:`
- Exception chaining: `raise NewError(...) from original` to preserve context
- `ExceptionGroup` + `except*` for concurrent error collection (3.11+)
- Context managers (`with`) for resource cleanup; avoid manual `try/finally`
- EAFP over LBYL when the common case succeeds

## Standard Library Preferences

- `pathlib.Path` over `os.path`
- `dataclasses` or Pydantic for structured data
- `asyncio` for I/O-bound concurrency; `concurrent.futures` for CPU-bound
- `contextlib.asynccontextmanager` for async resource management
- `enum.StrEnum` for string enumerations (3.11+)
- `functools.cache` / `lru_cache` for memoization
- `logging` with structured records; no `print()` in library code

## Devtools

- **Formatter/Linter**: `ruff` (replaces black, isort, flake8, pyupgrade)
- **Type checker**: `mypy --strict` (or `pyright` for library code)
- **Testing**: `pytest` (see `python-testing` skill)
- **Task runner**: `Makefile` or `uv run` scripts
- All tool config in `pyproject.toml`
