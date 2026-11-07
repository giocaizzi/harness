# Python: import-linter

Install as a dev dependency (`uv add --dev import-linter`). Put the contracts in `pyproject.toml`; `root_package` must be importable, so run through `uv run`.

```toml
[tool.importlinter]
root_package = "acme"
# include_external_packages = true   # needed to forbid third-party modules such as sqlalchemy

[[tool.importlinter.contracts]]
id = "layers"
name = "Layers: api > services > domain"
type = "layers"
layers = ["acme.api", "acme.services", "acme.domain"]
broken_contract_guidance = """
Imports go down only. Move the shared code into a lower layer, or pass it in
through a port declared in acme.domain.
"""

[[tool.importlinter.contracts]]
id = "domain-pure"
name = "Domain does not import infrastructure"
type = "forbidden"
source_modules = ["acme.domain"]
forbidden_modules = ["acme.db", "sqlalchemy", "httpx"]
broken_contract_guidance = """
The domain declares a port (a Protocol) and the db module implements it.
Pass the implementation in through the constructor in acme.api.
"""
# One reasoned exception per entry; an unmatched entry fails, so stale ones go.
# ignore_imports = ["acme.domain.legacy -> acme.db.session"]
```

External modules (`sqlalchemy`, `httpx`) in `forbidden_modules` need `include_external_packages = true`. For features that must not import each other, use an `independence` contract over the feature modules.

Run it in `lint` (the target changes nothing):

```make
lint:
	uv run ruff check .
	uv run mypy .
	uv run lint-imports
```

`broken_contract_guidance` is the rule's message: say what to do instead and where it lives. Run one contract with `uv run lint-imports --contract domain-pure`.
