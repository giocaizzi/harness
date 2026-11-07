# Modules

- Small and single-purpose; one lifecycle per module. If the inputs exceed what a reviewer can hold, split it.
- No `provider` blocks and no backend config inside; declare `required_providers` with version constraints and receive providers from the root (`providers = { ... }` for aliases).
- Typed variables with `description`; `validation` blocks on inputs that have a rule; `sensitive = true` on secrets; outputs only for what callers use.
- No secrets in outputs or default values. Take a secret reference (an ARN or ID), not a secret value.
- Resources that vary in number use `for_each` over a map or set with stable keys; keys are part of the address, so changing one is a move.
- `lifecycle { prevent_destroy = true }` on stateful resources (databases, buckets with data, key material).
- Renaming or restructuring inside a module ships a `moved` block in the same change, kept until all consumers have upgraded.
- Version modules with git tags or a registry; consumers pin an exact version (`?ref=v1.4.0` or `version = "1.4.0"`), never a branch.
- Tests live in `tests/` beside the module: [TESTING.md](TESTING.md).
- Commit `.terraform.lock.hcl` in each root; upgrade providers and modules in a change of their own so the diff shows only the upgrade.
