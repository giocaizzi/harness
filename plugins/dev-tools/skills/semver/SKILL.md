---
name: semver
description: Semantic Versioning 2.0.0 — how to choose MAJOR.MINOR.PATCH from the actual compatibility impact of a change, including pre-1.0 rules, deprecations, and release checklists. Use when deciding whether a change is breaking, additive, or a bug fix; planning a release; reviewing a version bump; or writing versioning policy for a package, API, CLI, library, or plugin. You must follow these rules always.
---

## Why this matters

Version numbers are a compatibility contract, not a status light. Consumers use them to decide whether they can upgrade safely, and automation uses them to decide what to publish. A wrong bump either hides a breaking change or creates unnecessary upgrade noise.

SemVer is about **public compatibility**:

- `MAJOR` for incompatible changes to the public contract
- `MINOR` for backward-compatible additions
- `PATCH` for backward-compatible fixes

Public contract means whatever consumers are expected to rely on: documented APIs, exported symbols, CLI flags, config formats, event payloads, database migration guarantees, file formats, or plugin manifests.

## The baseline rule

Choose the **smallest** version bump that truthfully describes the user-visible compatibility impact.

```text
MAJOR.MINOR.PATCH
```

- Increase `MAJOR` when existing consumers must change code, configuration, requests, or expectations.
  - `1.4.7` -> `2.0.0`
  - `1.4.7` -> `1.5.0`
  - `1.4.7` -> `1.4.8`

Ask these questions in order:

1. Would an existing consumer have to change anything to keep working?
2. If not, does the change add new supported behaviour?
3. If not, does it only repair incorrect behaviour?

Then map the answer:


Breaking means more than deleting a function. It includes any externally observable change that invalidates existing usage.

Typical `major` examples:

- Removing or renaming a public API, CLI command, config key, event, hook, or manifest field
- Changing function signatures, required parameters, return shapes, HTTP status behaviour, or payload schemas in incompatible ways
- Tightening validation so previously accepted input now fails
- Changing defaults in a way that changes observable behaviour for existing users
## What counts as a minor change

`Minor` is for new capability without breakage.

Typical `minor` examples:

- Adding a new optional parameter, endpoint, command, feature flag, exported helper, or manifest field
- Adding support for a new platform, integration, or configuration mode
- Adding a new event, extension point, or output field while keeping old ones valid
`Patch` is for compatibility-preserving repairs.

Typical `patch` examples:

- Fixing incorrect output, validation bugs, crashes, race conditions, or documentation examples that caused misuse
- Restoring documented behaviour after a regression
- Tightening implementation details without changing the supported contract
- Performance improvements that preserve semantics

Be careful: if the "bug fix" changes behaviour that users may have come to rely on, re-check whether it is actually breaking. Correctness does not automatically mean `patch`.

## Pre-1.0 versions

`0.y.z` means the API is still unstable, but it is not a license to version arbitrarily. Consumers still need a consistent signal.

Use these rules:

- Treat incompatible changes as at least a `minor` bump within `0.y.z`
- Treat backward-compatible additions as `minor` when they materially expand the contract
- Treat bug fixes as `patch`

Practical guidance:

- `0.4.2` -> `0.5.0` for breaking or materially additive contract changes
- `0.4.2` -> `0.4.3` for bug fixes

Once the contract is intentionally published and consumers can reasonably depend on it, move to `1.0.0` rather than hiding behind `0.x` forever.

## Deprecation policy

Use a two-step path for removals when possible:

1. Deprecate in a `minor` release. Keep the old surface working, mark it clearly, and document the replacement.
2. Remove it in the next `major` release.

Each deprecation notice should state:

- what is deprecated
- what to use instead
- when removal is expected

If you cannot provide a transition period because of security, safety, or severe correctness issues, call out the exception explicitly in the release notes.

## Public API checklist

Before choosing a bump, inspect all affected public surfaces:

- package exports and documented entry points
- CLI commands, flags, exit codes, and output formats
- configuration keys, defaults, and environment variables
- HTTP routes, status codes, schemas, auth requirements, and pagination behaviour
- events, hooks, callback order, and plugin manifests
- file formats, database compatibility promises, and migration requirements
- supported runtime and dependency ranges

If any of these become incompatible for existing consumers, it is a breaking change.

## Release decision workflow

Use this sequence every time:

1. Identify the public contract affected by the change.
2. Compare old consumer usage with new consumer usage.
3. Pick the smallest honest bump: `major`, `minor`, or `patch`.
4. Check whether multiple changes in the release require a higher bump.
5. Document deprecations and migrations before publishing.
6. Verify all version locations are updated consistently.

## Examples

| Change | Bump | Why |
|---|---|---|
| Add a new optional CLI flag | `minor` | additive, old usage still works |
| Remove a deprecated config key | `major` | existing configs can break |
| Fix incorrect JSON serialization while keeping schema stable | `patch` | behaviour repair only |
| Rename a plugin manifest field | `major` | consumers and tools must update |
| Add a new response field without removing old fields | `minor` | backward-compatible addition |
| Drop support for Python 3.10 | `major` | supported environment changed incompatibly |

## Common mistakes

- **Using `patch` for behaviour changes users depend on.** If callers must adapt, it is breaking.
- **Using `minor` for removals because a replacement exists.** Replacement availability does not make removal compatible.
- **Treating undocumented but widely-used behaviour as irrelevant.** If consumers reasonably rely on it, treat it as part of the contract until you intentionally break it.
- **Staying on `0.x` to avoid majors.** This hides risk instead of communicating it.
- **Bumping multiple files inconsistently.** Pick one release source of truth and keep mirrors in sync.

## Relationship to release automation

SemVer answers **what version should change**. Release tools answer **how that version gets published**.

- If the repo uses Conventional Commits, choose commit types that reflect the SemVer impact.
- If the repo uses release automation such as release-please, verify its bump rules match the intended SemVer contract.
- If automation and SemVer policy disagree, fix the automation or the commit classification rather than shipping the wrong version.

See [[conventional-commits]] for commit typing and [[release-please]] for automated release flow.

## When working with Claude

- Do not guess from code size; classify from compatibility impact.
- When asked to bump a version, first identify the affected public contract and whether consumers must change anything.
- If the repo already has a versioning policy, follow it unless it conflicts with an explicit user instruction.
- If the change spans package metadata, changelog tooling, and release automation, keep the source-of-truth version files aligned.