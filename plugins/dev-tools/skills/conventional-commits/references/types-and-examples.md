# Types and examples

| Type | Bump | Changelog section |
|---|---|---|
| `feat` | minor | Added / Features |
| `fix` | patch | Fixed / Bug Fixes |
| `perf` | patch | Performance |
| `refactor` | patch | Changed |
| `revert` | patch | Reverts |
| `docs` `style` `test` `build` `ci` `chore` | none | hidden |
| any `!` / `BREAKING CHANGE:` | major | Breaking |

Classification hints:
- Only test code changed (tests for existing behaviour): `test`.
- Only docs/comments/READMEs: `docs`.
- Whitespace, formatting, lint-only: `style`.
- Lockfiles and dependency bumps: `build` or `chore`; `chore(deps)` is the common convention.

## Examples

```text
feat(shell): add fzf preview to history search
```

```text
fix(env)!: remove deprecated PATH fallback

BREAKING CHANGE: legacy PATH fallback is no longer supported. Set
$PATH explicitly via the new $SHELL_PATH variable.
```

```text
refactor(parser): collapse tokenizer states into a single table

Same observable behaviour; reduces branch count from 14 to 6.
```

## Format details

- Header: one line, imperative mood, no trailing period, lowercase type, target <=72 chars. Body wraps at ~72 and explains why, not what.
- Mapping: `refactor` -> patch, `revert` -> patch (same as `perf`).
- Breaking: `!` or a `BREAKING CHANGE:` footer alone is sufficient; using both is acceptable for emphasis.

Scope examples:

- `feat(auth): ...` affects the auth module
- `fix(api/users): ...` nested scope is allowed but rare
- `chore(deps): ...` common convention for dependency bumps

## Common mistakes

- Capitalised description or trailing period: cosmetic, but breaks the changelog's visual consistency.
- Mixing scopes in one commit: split it; each commit targets one scope.
- `feat` for refactors inflates the minor version and pollutes "Added" with internal work.
- `fix` for behaviour added because something was missing: that is a `feat`.
- Forgetting `!` on a breaking change: release automation cuts a patch instead of a major.
