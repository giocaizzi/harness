# Project structure

Everything here ran with uv 0.13.7, ruff 0.17.4, mypy 2.4.1 and pytest 9.2 on CPython 3.14.10.

## Layout

```
project-root/
├── pyproject.toml        # metadata, dependencies, mypy, pytest, coverage
├── ruff.toml             # references/ruff.toml, unchanged until a rule needs a reason
├── uv.lock               # committed
├── .python-version       # the interpreter the project runs (uv python pin 3.15)
├── Makefile
├── README.md
├── src/
│   └── shop/             # import name; the distribution may be shop or shop-api
│       ├── __init__.py   # docstring only
│       ├── py.typed      # libraries: PEP 561 marker, empty
│       ├── cli.py        # main(argv) -> int; builds the dependencies
│       ├── errors.py     # class Error(Exception) and its subclasses
│       ├── orders.py     # one feature: its data classes and functions together
│       ├── pricing.py
│       └── notifications/  # a feature that outgrew one module
│           ├── __init__.py
│           ├── alerts.py
│           └── slack.py
└── tests/                # no __init__.py; mirrors src/shop by feature
    ├── conftest.py
    ├── test_orders.py
    └── notifications/
        └── test_alerts.py
```

`src/` keeps tests running against the installed package, not the working directory. Modules are named for the feature they hold; there is no `models.py`, `services/` or `utils.py` to collect unrelated code by kind.

## pyproject.toml

```toml
[project]
name = "shop"
version = "0.1.0"
description = "Prices and orders."
readme = "README.md"
license = "MIT"
requires-python = ">=3.14"
dependencies = [
    "httpx>=0.28",
]

[project.scripts]
shop = "shop.cli:main"

[dependency-groups]
dev = [
    "mypy>=2.4",
    "ruff>=0.17",
    # the test stack: python-testing skill
]

[build-system]
requires = ["uv_build>=0.13.7,<0.14"]
build-backend = "uv_build"

[tool.mypy]
strict = true
files = ["src", "tests"]
enable_error_code = ["explicit-override", "ignore-without-code", "redundant-expr", "truthy-bool", "possibly-undefined", "unused-awaitable"]
warn_unreachable = true
# plugins = ["pydantic.mypy"]  # when Pydantic is a dependency

# [tool.pytest] and [tool.coverage.*]: python-testing skill
```

- `uv add <pkg>` writes a lower bound; the lockfile pins exact versions. `uv add --dev <pkg>` lands in the `dev` group, which `uv sync` installs by default; another group (`docs`, `bench`) is synced with `--group`.
- `uv_build` expects the import package at `src/<normalized project name>/`; when it differs set `[tool.uv.build-backend] module-name = "..."`.
- The version lives only in `pyproject.toml` (release-please bumps it and `uv.lock`); read it at runtime with `importlib.metadata.version("shop")`.

## Makefile

```makefile
.DEFAULT_GOAL := help
.PHONY: help fmt lint test check

help: ## List targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | sed 's/:.*## /\t/'

fmt: ## Format and apply safe lint fixes
	uv run ruff format
	uv run ruff check --fix

lint: ## Lockfile, format, lint and type check, changing nothing
	uv lock --check
	uv run ruff format --check
	uv run ruff check
	uv run mypy

test: ## Run the tests in parallel, with coverage
	uv run pytest --cov --cov-report=term-missing:skip-covered

check: lint test ## lint + test
```

CI runs `uv sync --locked` and then `make check` (workflow shape: the `github-actions` skill). A library also runs `make test` on each Python version it claims, `uv run --python 3.N`.

## Single-file scripts

A script outside the package carries its own dependencies (PEP 723) and needs no project:

```bash
uv init --script scripts/backfill.py --python 3.15
uv add --script scripts/backfill.py httpx
uv run scripts/backfill.py --dry-run
```

`uv lock --script scripts/backfill.py` writes `backfill.py.lock` beside it when the script must be reproducible. A script that grows tests or a second module becomes a package in `src/`.

## Workspaces

Several packages that release together share one lockfile:

```toml
# root pyproject.toml
[tool.uv.workspace]
members = ["packages/*"]

[tool.uv.sources]
shop-core = { workspace = true }
```

Each member has its own `pyproject.toml` and `src/`; `uv run --package shop-api pytest` runs one member's tests. Packages that release separately are separate repos.

## Typed libraries

A library ships `src/<package>/py.typed` (empty) so type checkers read its annotations; without it consumers see `Any`.
