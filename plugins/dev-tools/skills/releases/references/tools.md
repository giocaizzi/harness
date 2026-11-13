# Release tools

The house choice for anything with a SemVer release is release-please. Keep a repo's existing tool unless it is failing it; propose a switch in its own PR.

| Tool | What it owns | Where its specifics are |
|---|---|---|
| release-please | release PR, version files, changelog, tag, forge release, from Conventional Commits | `release-please` skill |
| semantic-release | the same, released on every push without a release PR | its docs; publishing still runs from the tag as in SKILL.md |
| Changesets | versions and changelogs from changeset files written per PR; strong in JS monorepos | its docs |
| goreleaser | builds, archives, checksums, SBOMs and attestations for Go binaries, from the tag another tool made | `go-development`, references/RELEASE.md |
| cargo-release, `uv publish`, `npm publish` | the publish step itself | the language skill |
| fastlane, Gradle Play Publisher, Xcode Cloud | store builds, signing and upload | [store-apps.md](store-apps.md) |

- One tool owns the version. Two tools that both bump it (release-please and Changesets, or a manual `npm version` next to either) fight, and the manifest drifts from the tags.
- A tool that releases on every push (semantic-release) suits libraries released per change; a release PR (release-please) suits batched releases, the house default.
- Monorepos: independent versions per package where packages are consumed separately; one fixed version where they always ship together.
