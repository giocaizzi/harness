---
name: semver
description: Choosing MAJOR.MINOR.PATCH from the real compatibility impact of a change, including pre-1.0 and deprecation policy. Use when deciding if a change is breaking, planning a release, reviewing a version bump, or writing versioning policy.
---

Versions are a compatibility contract, not a status light: consumers decide whether to upgrade from them and automation decides what to publish. Classify from compatibility impact, never from code size. A wrong bump either hides a breaking change or creates upgrade noise.

The public contract is whatever consumers are expected to rely on: documented APIs and exports, CLI flags and exit codes, config keys and defaults, HTTP schemas and status codes, events/hooks, file formats, migration guarantees, plugin manifests, supported runtime ranges. Check [references/public-surface-checklist.md](references/public-surface-checklist.md) when a change touches several surfaces or you are unsure what counts.

## Deciding the bump

Choose the smallest bump that truthfully describes impact. Ask in order:

1. Must an existing consumer change anything to keep working? `major`.
2. Else, does it add supported behaviour? `minor`.
3. Else, does it only repair incorrect behaviour? `patch`.

Gotchas, each because the naive answer misclassifies:
- Breaking is broader than deletion: tightened validation, changed defaults, new required parameters, changed payload shape, dropped runtime support.
- A bug fix that changes behaviour users have come to rely on may be breaking. Correctness does not automatically mean `patch`.
- A replacement existing does not make a removal `minor`.
- Undocumented but widely relied-on behaviour is part of the contract until you intentionally break it.
- With several changes in one release, the highest required bump wins.

## Pre-1.0

`0.y.z` is unstable but not a license to version arbitrarily: breaking or materially additive changes bump `minor`, fixes bump `patch`. Move to `1.0.0` once consumers can reasonably depend on the contract; staying on `0.x` to avoid majors hides risk instead of communicating it.

## Deprecation

Prefer two steps: deprecate in a `minor` (old surface keeps working, replacement documented, removal timing stated), remove in the next `major`. If security or severe correctness forces skipping the transition, say so explicitly in the release notes.

## Release hygiene

- Pick one source of truth for the version and keep mirrors in sync across files.
- Document deprecations and migrations before publishing.
- If automation (release-please, Conventional Commits) disagrees with the intended SemVer impact, fix the automation or the commit classification rather than shipping the wrong version. See `conventional-commits` and `release-please`.
- If the repo has its own versioning policy, follow it unless the user says otherwise.

Typical major/minor/patch examples, the pre-1.0 additive nuance, deprecation notice contents and a 6-step decision workflow are in [references/bump-examples.md](references/bump-examples.md); read when classifying a non-obvious change or preparing a release.
