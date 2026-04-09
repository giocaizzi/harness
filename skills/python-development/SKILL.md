---
name: python-development
description: python development best practices and conventions. Use this skill whenever you are developing Python code. You must follow these guidelines always.
metadata:
  version: "2.0"
---

## Python 3.13

Modern Python development guidelines.

## Project

Defined in `pyproject.toml`, using `poetry` or `uv` for dependency management.
All plugins/tools configured via `pyproject.toml`.

## Typing
- Type hints on all functions/methods; no `Any` (use `object` + `isinstance` or generics)
- Forward references work natively (PEP 649).
- Use `TYPE_CHECKING` only for: (1) avoiding circular imports, (2) imports used exclusively in type hints
- Use `|` union syntax, not `Union`/`Optional`

### Prohibited

- `Any` type, `typing.cast`, `# type: ignore`, `from __future__ import annotations`
- mutable default args, `*args/**kwargs` without typing,

## Import Rules

## Standard Library Usage
- Prefer `pathlib.Path` over `os.path`
- Use dataclasses or Pydantic for data structures
- Use `asyncio` for I/O-bound operations
- Use `contextlib.asynccontextmanager` for async resources


## Code style

Follow clear code style:
- Object-oriented design; single responsibility principle
- **Composition over inheritance**
- Modular, reusable functions/classes
- Classes when managing state or behavior, functions for stateless operations
- Meaningful names; avoid abbreviations
- Docstrings for all public functions/classes (Google style)

### Imports

Use relative imports within the same top-level module (for conciseness) and absolute imports outside of the top-level module (for explicitness).
- Single-dot relative imports (.module): For sibling modules in the same directory
- Absolute imports: For everything else (parent modules, cross-module, external packages)

## Devtools

- Use `ruff` for linting and formatting
- Use `mypy` with strict mode for type checking
- Use `pytest` for testing (see `python-testing` skill)
