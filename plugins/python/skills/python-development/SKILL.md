---
name: python-development
description: "House rules for Python 3.12+ code: typing, errors, data classes, project layout, uv/ruff/mypy and make targets. Use whenever you write or change Python (.py) code, whether adding a function or feature, fixing a bug, refactoring, reviewing, or setting up a new Python project, even when the user does not mention conventions."
---

# Python Development (3.12+)

Target 3.12 as the floor. Use newer features when the project's `requires-python` allows, and `typing_extensions` for the rest.

## Tooling

- Use `uv` for everything (`uv add`, `uv sync`, `uv run`, `uv tool install`/`uvx` for CLIs). Never pip, pipx or global installs: they bypass the lockfile and make environments irreproducible.
- `pyproject.toml` is the single source of truth (metadata, deps, tool config). Commit `uv.lock` (list it in release-please `extra-files` so its recorded version is bumped: see the `release-please` skill). Use `src/<package>/` layout so tests run against the installed package, not the working directory.
- `ruff` for format and lint (replaces black/isort/flake8); `mypy --strict` (or `pyright` for libraries).
- Navigate code by symbol with the LSP tool where you have one (definitions, references, callers, type errors) before grep; grep for text, config and languages without a language server.
- New projects start with every ruff rule and Google docstrings; ignore a rule only when it conflicts with another tool, with the reason inline:
  ```toml
  [tool.ruff.lint]
  select = ["ALL"]
  ignore = ["COM812", "ISC001"]  # conflict with ruff format

  [tool.ruff.lint.pydocstyle]
  convention = "google"
  ```
- Run tasks through `make` with the standard targets `help`, `lint`, `test`, `check` (`check` = `lint` + `test`). One predictable command surface lets humans, CI and agents run the same checks without guessing; use `make` when a Makefile exists, and add these targets when it doesn't.

## Typing

- Annotate every function, method and module-level variable.
- Use 3.12 syntax: `class Foo[T]`, `def f[T](x: T)`, `type Alias = ...`, `X | None` (never `Union`/`Optional`/`typing.List` etc.), `@override`.
- Parameters take the widest type the code supports (`Sequence`, `Mapping`, `Iterable`); returns the narrowest concrete type.
- Prefer `Protocol` over ABC when callers shouldn't inherit from your type; prefer `TypeIs` over `TypeGuard`.
- Avoid `Any` (use `object` + `isinstance`, or generics), `typing.cast` and `# type: ignore`; when unavoidable, add a justification comment. They silence the checker instead of fixing the model.
- On 3.12-3.13 use `from __future__ import annotations` for forward references; unnecessary on 3.14.
- Use `TYPE_CHECKING` only for circular imports or annotation-only imports.

Read [references/TYPING.md](./references/TYPING.md) for the version-feature table, overloads, protocols vs ABC, ParamSpec decorators, TypedDict and `typing_extensions` bridging.

## Design and style

- Composition over inheritance: inject collaborators (constructor injection, no DI framework). Inherit only for framework hooks (e.g. `Exception`) or shallow stable hierarchies you own.
- Structured data is `@dataclass(slots=True)` (add `frozen=True` for value objects) or Pydantic `BaseModel` for external input; never raw dicts, because dict shapes are invisible to the type checker.
- Classes for state plus behavior; plain functions for stateless transforms.
- Optional params are keyword-only (`def f(x, *, timeout=5.0)`). No mutable default arguments; no untyped `*args`/`**kwargs`.
- Names are meaningful, unabbreviated, verb-prefixed for functions. Google-style docstrings on public API stating what and why; skip for obvious private helpers.
- Imports: relative within the same top-level package, absolute otherwise; no wildcard imports.
- Prefer stdlib: `pathlib` over `os.path`, `StrEnum`, `functools.cache`, `asyncio` for I/O-bound and `concurrent.futures` for CPU-bound work. `logging`, not `print()`, in library code.

## Errors

- Raise specific exceptions (names end in `Error`, derive from an app-level base); catch narrowly, never bare `except:`.
- Chain with `raise New(...) from exc` to keep the cause.
- Use `with` for cleanup; EAFP when the common case succeeds; `ExceptionGroup`/`except*` and `asyncio.TaskGroup` for concurrent failures.

Read [references/PATTERNS.md](./references/PATTERNS.md) for dataclass vs Pydantic vs TypedDict guidance, DI, Result pattern, exception hierarchy, async and module-organization examples.

Read [references/PROJECT_STRUCTURE.md](./references/PROJECT_STRUCTURE.md) when scaffolding a project: directory layout, `pyproject.toml` template, uv workflows, Makefile, py.typed, workspaces.

## Gotchas

- `uv pip install` is still pip: it changes the environment without touching `pyproject.toml` or `uv.lock`, so the next `uv sync` undoes it. Use `uv add`.
- A Pydantic model resolves its annotations at runtime, so a type imported only under `TYPE_CHECKING` leaves it "not fully defined". Import model field types for real.
- In an existing repo, its own ruff and mypy settings win: don't switch on `select = ["ALL"]` or `--strict` in a change that is about something else.
