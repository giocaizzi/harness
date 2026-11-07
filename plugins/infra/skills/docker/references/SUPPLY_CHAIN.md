# Supply chain

## Pinning

- `FROM image:tag@sha256:<digest>`: the tag documents intent, the digest fixes the content. Do the same for `COPY --from=image` and compose images.
- The update bot (Renovate or Dependabot) opens a PR bumping tag and digest; CI builds and scans it. No manual digest edits.

## Labels

Set at build time from CI, not hard-coded:

```dockerfile
ARG SOURCE
ARG REVISION
LABEL org.opencontainers.image.source=$SOURCE \
      org.opencontainers.image.revision=$REVISION
```

`source` is the repository URL, `revision` the commit SHA; `org.opencontainers.image.version` carries the release version. `docker/metadata-action` generates the set. Declare the `ARG`s in the final stage, after its `FROM`.

## Lint

hadolint is a `make lint` step (`hadolint Dockerfile`, or its container image where the host has no binary), configured in `.hadolint.yaml` (`failure-threshold`, `ignored`). An ignored rule carries its reason as a comment. Clean means exit 0.

DL3008 (pin apt package versions) is ignored on purpose: the base image is pinned by digest and bumped by the update bot, so apt versions move with it.

```yaml
# .hadolint.yaml
ignored:
  - DL3008 # base pinned by digest, bumped by the bot
```

## Scan and provenance

- CI scans every built image (Trivy or Grype) and fails on fixable high or critical findings; the same scan runs on a schedule for images already shipped.
- Generate an SBOM and provenance attestation at build (`docker buildx build --sbom=true --provenance=mode=max`), and sign the pushed digest (cosign keyless) on release.

## Multi-arch

Only on release: `docker buildx build --platform linux/amd64,linux/arm64`. PR and branch builds use the runner's native architecture. Cross-compile in the build stage (`--platform=$BUILDPLATFORM`, `TARGETARCH`) instead of emulating where the language allows it.
