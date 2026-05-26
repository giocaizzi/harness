# Project Structure Reference

Standard Python project layout and tooling for 3.12+ projects.

## Directory Layout

```
project-root/
├── pyproject.toml          # Single source of truth
├── uv.lock                 # Locked dependencies (committed)
├── README.md
├── Makefile                # Task runner (or justfile)
├── src/
│   └── my_package/
│       ├── __init__.py
│       ├── py.typed        # PEP 561 marker (for typed libraries)
│       ├── core/
│       │   ├── __init__.py
│       │   └── models.py
│       └── services/
│           ├── __init__.py
│           └── user.py
├── tests/
│   ├── conftest.py
│   ├── unit/
│   │   └── test_models.py
│   └── integration/
│       └── test_user_service.py
├── docs/                   # Optional
└── scripts/                # One-off scripts, migrations
```

### Why `src/` layout?

- Prevents accidental imports of the uninstalled package
- Forces you to install the package (editable) before testing
- Matches PyPA recommendations and `uv`/`pip` defaults

## pyproject.toml

Minimal modern `pyproject.toml` with `uv`:

```toml
[project]
name = "my-package"
version = "0.1.0"
description = "A short description"
requires-python = ">=3.12"
dependencies = [
    "httpx>=0.27",
    "pydantic>=2.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0",
    "pytest-cov>=5.0",
    "mypy>=1.10",
    "ruff>=0.5",
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/my_package"]

[tool.ruff]
target-version = "py312"
src = ["src", "tests"]

[tool.ruff.lint]
select = ["ALL"]
ignore = [
    "D",        # pydocstyle (handled separately)
    "ANN101",   # missing self type
    "ANN102",   # missing cls type
    "COM812",   # trailing comma (conflicts with formatter)
    "ISC001",   # single-line string concat (conflicts with formatter)
]

[tool.ruff.lint.isort]
known-first-party = ["my_package"]

[tool.mypy]
strict = true
plugins = []
mypy_path = "src"

[[tool.mypy.overrides]]
module = "tests.*"
disallow_untyped_defs = false

[tool.pytest.ini_options]
testpaths = ["tests"]
addopts = "-ra --strict-markers"
```

## Package Manager: uv

`uv` is the recommended package manager (fast, Rust-based, pip-compatible).

### Common workflows

```bash
# Initialize new project
uv init my-project
cd my-project

# Add dependencies
uv add httpx pydantic
uv add --dev pytest mypy ruff

# Install (creates venv automatically)
uv sync

# Run commands in the venv
uv run pytest
uv run mypy src/

# Update lockfile
uv lock

# Build and publish
uv build
uv publish
```

### Key principles

- **Always commit `uv.lock`** — ensures reproducible installs
- **Use `uv run`** for one-off commands instead of activating venv
- **Pin ranges** in `pyproject.toml` (`>=1.0,<2.0`), exact versions in lockfile
- **Separate dev deps** via `[project.optional-dependencies]` or `[dependency-groups]`

## py.typed Marker

For libraries that ship type information, include an empty `py.typed` file:

```
src/my_package/py.typed    # empty file, signals PEP 561 compliance
```

This tells type checkers that your package provides inline type annotations.
Without it, tools like `mypy` may ignore your package's types.

## Environment Management

```bash
# uv auto-creates .venv/ — no manual virtualenv creation needed
uv sync                    # install all deps into .venv/

# Pin Python version
uv python pin 3.12         # creates .python-version file

# Multiple Python versions for testing
uv run --python 3.13 pytest
```

## Makefile (Task Runner)

```makefile
.PHONY: lint test typecheck format all

all: format lint typecheck test

format:
	uv run ruff format src/ tests/

lint:
	uv run ruff check src/ tests/ --fix

typecheck:
	uv run mypy src/

test:
	uv run pytest --cov=my_package

clean:
	rm -rf dist/ .mypy_cache/ .pytest_cache/ .ruff_cache/
```

## Versioning

- Use **single-source versioning** — version lives in `pyproject.toml` only
- For dynamic versioning from VCS tags: use `hatch-vcs` or `setuptools-scm`
- Follow [SemVer](https://semver.org/) for libraries; CalVer acceptable for applications

## Multi-Package / Monorepo

For workspaces with multiple packages:

```toml
# Root pyproject.toml
[tool.uv.workspace]
members = ["packages/*"]
```

Each package has its own `pyproject.toml` under `packages/<name>/`.
