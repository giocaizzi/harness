# Releases: release-please + goreleaser

Division of labour: **release-please** owns the version, `CHANGELOG.md`, the tag and the GitHub Release with its notes (see the `release-please` skill; `release-type: go`, which tracks only the changelog, since a Go module has no version file). **goreleaser** builds the binaries from that tag and attaches archives, checksums, SBOMs and the Homebrew cask. The workflow then attests the artifacts.

## .goreleaser.yaml

Checked with goreleaser v2.18.3 (`goreleaser check`, and `goreleaser release --snapshot --clean`: six targets, archives, SBOMs, cask; the `hooks.post.install` quarantine hook below validated too).

```yaml
version: 2

before:
  hooks:
    - go mod tidy -diff

builds:
  - id: <name>
    main: ./cmd/<name>
    env:
      - CGO_ENABLED=0
    goos: [darwin, linux, windows]
    goarch: [amd64, arm64]
    flags:
      - -trimpath
    ldflags:
      - -s -w
    mod_timestamp: "{{ .CommitTimestamp }}"

archives:
  - formats: [tar.gz]
    format_overrides:
      - goos: windows
        formats: [zip]

checksum:
  name_template: checksums.txt

sboms:
  - artifacts: archive      # syft must be on PATH

changelog:
  disable: true             # release-please wrote the notes

release:
  mode: keep-existing       # attach to the release release-please created, keep its body

homebrew_casks:
  - name: <name>
    repository:
      owner: <owner>
      name: homebrew-tap
      token: "{{ .Env.HOMEBREW_TAP_TOKEN }}"
```

- **Reproducible**: `-trimpath`, `mod_timestamp` from the commit, `CGO_ENABLED=0`, and the same Go everywhere (the `toolchain` line, read by `setup-go` through `go-version-file`). VCS stamping stays on (the default `-buildvcs=auto`): it records the commit and time from git, not the clock, and gives `debug.ReadBuildInfo().Main.Version` the tag.
- **No `-X main.version`**: the version is the module version `go build` stamps from the tag (Go 1.24+); a package-level variable would also trip `gochecknoglobals`.
- **Homebrew**: `homebrew_casks` (goreleaser 2.10+) replaces the deprecated `brews` formulae. An unsigned, unnotarised macOS binary is quarantined by Gatekeeper; until the binary is signed and notarised, add the hook below and say so in the README:
  ```yaml
      hooks:
        post:
          install: |
            if OS.mac?
              system_command "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "#{staged_path}/<name>"]
            end
  ```
- Linux packages (`nfpms`), Scoop and container images are additions to the same file when a consumer needs them.

## Workflow

Tags that release-please creates with `GITHUB_TOKEN` do not trigger other workflows, so goreleaser runs as a second job of the release-please workflow, gated on its output.

```yaml
name: release-please

on:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  release-please:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    outputs:
      release_created: ${{ steps.release.outputs.release_created }}
      tag_name: ${{ steps.release.outputs.tag_name }}
    steps:
      - id: release
        uses: googleapis/release-please-action@v5

  goreleaser:
    needs: release-please
    if: needs.release-please.outputs.release_created == 'true'
    runs-on: ubuntu-latest
    environment: release
    permissions:
      contents: write        # upload to the release
      id-token: write        # attestations (Sigstore OIDC)
      attestations: write
    steps:
      - uses: actions/checkout@v7
        with:
          ref: ${{ needs.release-please.outputs.tag_name }}
          fetch-depth: 0
      - uses: actions/setup-go@v7
        with:
          go-version-file: go.mod
      - uses: anchore/sbom-action/download-syft@v0
      - uses: goreleaser/goreleaser-action@v7
        with:
          distribution: goreleaser
          version: "~> v2"
          args: release --clean
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          HOMEBREW_TAP_TOKEN: ${{ secrets.HOMEBREW_TAP_TOKEN }}
      - uses: actions/attest@v4
        with:
          subject-checksums: dist/checksums.txt
```

- `HOMEBREW_TAP_TOKEN` is a fine-grained token with contents write on the tap repo only, stored as a secret of the `release` environment (org standard: publish jobs run in an environment).
- Users verify with `gh attestation verify <archive> -R <owner>/<repo>`. Artifact attestations replace a cosign signing step for GitHub-hosted releases; add goreleaser's `signs` with cosign only when consumers verify outside GitHub.
- Run `make snapshot` (or `goreleaser check`) in the PR that changes `.goreleaser.yaml`; a broken config otherwise surfaces only after the release PR merged and the tag exists.

## Gotchas

- `release.mode` defaults to `keep-existing`, but set it explicitly: `replace` would overwrite release-please's notes.
- goreleaser refuses a dirty tree: `before.hooks` that rewrite files (`go mod tidy` without `-diff`, code generation) fail the release. Generated code is committed.
- release-please's monorepo tags (`<component>-vX.Y.Z`) are not semver tags to goreleaser; keep one module and one binary set per repo with plain `vX.Y.Z` tags.
