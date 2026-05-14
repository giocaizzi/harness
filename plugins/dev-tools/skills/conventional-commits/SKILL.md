---
name: conventional-commits
description: Conventional Commits 1.0.0 — how to write commit messages whose `type` carries machine-readable intent (bump, changelog section, breaking change). Use whenever you are about to write a git commit message, draft a PR title, or rewrite history. You must follow these rules always.
---

## Why this matters

The commit `type` is not a stylistic choice — release automation (release-please, semantic-release, Changesets, etc.) reads it to decide the version bump and which changelog section the entry lands in. A wrong `type` ships the wrong version or hides a real change from users. Treat the header as an API.

## Header format

```text
<type>[optional scope][!]: <description>
```

- One line, imperative mood, no trailing period.
- `<description>` should fit on one line (target ≤72 chars).
- Lowercase `<type>`. Scope, if used, is a lowercase noun in parentheses.
- `!` after type/scope **and/or** a `BREAKING CHANGE:` footer marks a breaking change. Either alone is sufficient; using both is fine.

Full message:

```text
<type>[optional scope][!]: <description>

[optional body — wrap at ~72, explain *why*, not *what*]

[optional footer(s) — `BREAKING CHANGE: …`, `Refs: …`, `Co-authored-by: …`]
```

A blank line separates header, body, and footers.

## Types and their bump semantics

| Type | Bump | Typical changelog section |
|---|---|---|
| `feat` | minor | Added / Features |
| `fix` | patch | Fixed / Bug Fixes |
| `perf` | patch | Performance |
| `refactor` | patch | Changed |
| `revert` | patch | Reverts |
| `docs` | none | (hidden) |
| `style` | none | (hidden) |
| `test` | none | (hidden) |
| `build` | none | (hidden) |
| `ci` | none | (hidden) |
| `chore` | none | (hidden) |
| any `!` / `BREAKING CHANGE:` | major | Breaking |

The bump mapping above is the convention most release tools default to. The exact mapping is configurable per repo (e.g. `release-please-config.json`); when in doubt, read that config rather than guessing.

## Choosing the right type

- **User-visible new behaviour** → `feat`. A new flag, a new endpoint, a new UI affordance.
- **User-visible bug repair** → `fix`. Includes correctness regressions and security patches.
- **No behaviour change for callers** → `refactor`. Internal restructuring, renamings, dead-code removal.
- **Faster or lighter, same behaviour** → `perf`.
- **Only test code changed** → `test`. Adding tests for existing behaviour, not new features.
- **Only docs changed** → `docs`. Comments and READMEs.
- **Tooling, CI, lockfiles, dependency bumps** → `chore` / `build` / `ci`. `build` for the build system (bundlers, package managers), `ci` for pipeline config, `chore` for everything else housekeeping.
- **Whitespace, formatting, lint-only** → `style`.

If a commit mixes types (e.g. a `feat` that drags along test updates), classify by the **most impactful** change. Don't split a coherent change just to satisfy types — but do split unrelated changes.

## Scope

Optional. Use a short noun that names the affected subsystem, package, or surface. Examples:

- `feat(auth): …` — affects the auth module
- `fix(api/users): …` — nested scope is allowed but rare
- `chore(deps): …` — common convention for dependency bumps

Pick scopes from a small, stable vocabulary that already exists in the repo's commit log. Don't invent a new scope per commit.

## Breaking changes

Anything that forces consumers to change code, config, or behaviour is breaking. Examples: removing a public API, renaming a flag, changing default behaviour, dropping support for a runtime version.

Mark in **one** of two ways (or both for emphasis):

```text
feat(api)!: drop /v1 endpoints

BREAKING CHANGE: /v1/* is gone; callers must migrate to /v2/*.
The old handlers were removed in this commit.
```

The body of `BREAKING CHANGE:` should tell the reader **what broke and how to migrate**. Release notes are generated verbatim from this footer in most tools.

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

Same observable behaviour; reduces branch count from 14 to 6 and
removes the duplicated whitespace handling in `state_machine.c`.
```

```text
chore(deps): bump pydantic 2.7.1 → 2.7.4
```

## Common mistakes

- **Using `feat` for refactors** — inflates the minor version and pollutes the "Added" section with internal work.
- **Using `fix` for new behaviour added because something was missing** — that's a `feat`. `fix` is for repairing previously-broken behaviour.
- **Forgetting `!` on a breaking change** — release-please will cut a patch instead of a major. Always re-read the diff and ask: *would a consumer have to change anything?*
- **Capitalised description or trailing period** — cosmetic but it breaks the changelog's visual consistency.
- **Mixing scopes in one commit** — split the commit; each commit should target one scope.

## When working with Claude

- Before composing the message, look at recent `git log --oneline -20` to learn the repo's scope vocabulary and tone.
- If a release-automation config exists (`release-please-config.json`, `.changeset/`, `package.json#release`, `cz-config.js`), read it — it may redefine the type-to-section or type-to-bump mapping.
- Never amend or rewrite an already-pushed commit message to "fix the type" without confirming with the user; it forces a force-push.
