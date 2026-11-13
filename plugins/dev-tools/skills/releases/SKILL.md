---
name: releases
description: "Use when someone wants to release, publish (PyPI, npm, a store), tag or cut a version, write release notes or a changelog, ship a candidate or hotfix, yank a version, set up a release pipeline, choose a release tool, or a release went wrong."
---

# Releases

Covers any stack and tool (release-please, semantic-release, Changesets, goreleaser, fastlane): cadence, release PRs, tags, release notes, pre-releases, hotfixes and maintenance lines, yanking a bad version, publishing to a registry or store, provenance attestations and the latest marker.

A release gives an artifact a name that people outside the repo rely on. The version number is `semver`'s; the commit input to it is `conventional-commits`'; the pipeline that builds, publishes and deploys is `ci-cd` (on GitHub, `github-actions`); the house tool for libraries is `release-please`. This skill is what holds whichever of those is in play.

## First: what kind of thing ships

Who reads the version decides everything else.

| Kind | Who reads the version | Version | Release tool | Going back |
|---|---|---|---|---|
| Library, SDK, CLI, plugin, chart | other people's code, choosing what to install | SemVer, a compatibility contract | `release-please` | consumers pin the old version; yank the bad one and ship a fix |
| Deployed service, web app, worker | nobody installs it: you deploy it | the commit SHA and image digest; a CalVer label only when humans need one | none: deploy continuously (`ci-cd`) | redeploy the previous digest |
| Mobile, desktop or store app | stores and end users | a user-facing marketing version plus a build number that strictly increases on every upload | a release train, build number from CI: [references/store-apps.md](references/store-apps.md) | none: roll forward with a new build |

A service's contract is its API, versioned there (`api-design`), not by the app's version. A repo holding several kinds releases each by its own row.

## The release, for anything that gets a version

- **A release is a reviewed change.** A release PR proposes the version and notes; merging it creates the tag; the tag triggers publishing. Nothing is released from a laptop.
- **Batch, then release.** Release when the set of changes meant to ship together has landed and the merge queue is empty (`github-pull-requests`, rule 10); a security fix ships at once.
- **Build once, by kind.** A package is built and published from the tagged release commit: it passed the gate as a PR, and the registry reads the version inside the package. An image or binary that was already tested keeps its digest: the version comes from the tag at build time (Go stamps it from the tag, `go-development`) and the tested artifact is promoted, not rebuilt (`ci-cd`, `docker`).
- **Publishing runs from the tag, in a named environment**, with federated identity or the registry's trusted publishing and no long-lived token (`ci-cd`), and is safe to re-run: it skips what is already published.
- **Every published artifact carries build provenance** (an attestation from the build that made it). Signing on top is for consumers who verify signatures outside the forge (`docker`, `go-development`).
- **Published means immutable.** A tag, a registry version and a store build are never moved, deleted or overwritten. A bad release is yanked or deprecated, and the fix ships as the next version.
- **Notes are for users**: what changed for them and what they must do, breaking changes and migrations first. The changelog is generated from the commits; an override goes through the tool, never a hand edit of the generated file.
- **Prove it landed**: the registry or store shows the new version, it installs, and the latest marker points at it (`land`, step 7).

Situations with their own reference:

| Situation | Read |
|---|---|
| Patching an older version while `main` moved on; a hotfix | [references/maintenance-lines.md](references/maintenance-lines.md) |
| Pre-releases, release candidates, a release that went wrong, yanking | [references/recovery.md](references/recovery.md) |
| App store or desktop builds, staged rollout, forced update | [references/store-apps.md](references/store-apps.md) |
| Picking or replacing a release tool | [references/tools.md](references/tools.md) |

## Gotchas

- A service on release-please piles up release PRs whose versions say nothing, and every deploy waits on someone merging one: a deployed service ships by digest.
- A tag created with the forge's default token starts no other workflow, so the publish job never runs and nothing says so (on GitHub: `github-actions`, Gotchas).
- A publish that failed halfway is re-run for what is missing only. A version whose content was wrong cannot be replaced: npm, PyPI and crates.io keep a version or file name reserved even after it is deleted, so the fix is the next patch.
- A moved or re-pushed tag is never seen by consumers who already fetched it, and the Go module proxy and checksum database keep the first content forever.
- A maintenance release published later than `main`'s newest takes the latest marker, and a `:latest` image tag moves back with it (`release-please`, references/release-flow.md).
- A store rejects a build number it has seen before, even from a build that never shipped.
- Version-bearing files the tool does not know about drift silently until a user reports the wrong version.
