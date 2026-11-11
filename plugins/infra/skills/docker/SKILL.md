---
name: docker
description: "Dockerfiles, .dockerignore, compose files and image builds: multi-stage builds with dev/test/prod stages, minimal non-root final images, base images pinned by tag and digest, BuildKit cache and secret mounts, layer caching, exec-form CMD, health checks, OCI labels, hadolint, image scanning, tagging and promoting one image across environments. Use when writing or changing a Dockerfile, .dockerignore or compose file, containerizing a service, building or tagging an image, or fixing a slow, cache-busting, oversized or leaking image build."
---

# Docker

Category: code scaffolding and templates. One image per deployable, built once and promoted. The opinions below are defaults; deviate only with a reason in a comment.

## Opinions

1. **One Dockerfile per deployable**, with named stages (`dev`, `test`, `prod`) in that one file, never `Dockerfile.dev` copies. Monorepo: build from the workspace root with a `.dockerignore` allowlist (`*` then `!path`). Detail: [BUILD.md](references/BUILD.md).
2. **Multi-stage, minimal final image.** Build tools stay in the build stage. A static Go binary (`CGO_ENABLED=0`) ships on a minimal base (`scratch` or distroless static); anything else on a slim base.
3. **Non-root, numeric UID** (`USER 10001`), set before `CMD`. `COPY --chown` for files the app writes.
4. **Base pinned by tag and digest** (`FROM python:3.14-slim@sha256:...`); the update bot (Renovate or Dependabot) bumps both. Never `latest`.
5. **`.dockerignore` is mandatory**: `.git`, env files, build output, local caches.
6. **Dependency layers before source**: copy the lockfile, install, then copy the source. Use a BuildKit cache mount for the package cache.
7. **Secrets via `RUN --mount=type=secret`**, never `ARG`, `ENV` or `COPY`: they stay in the image history.
8. **Exec-form `CMD`/`ENTRYPOINT`** (`["app"]`) so signals reach PID 1. One process per container.
9. **Health by probe or `HEALTHCHECK`**; the orchestrator's probe wins where there is one. Runtime detail: [RUNTIME.md](references/RUNTIME.md).
10. **The same image is promoted** across environments; configuration arrives at runtime (env, mounted files), never per-environment image variants. Tags carry the git SHA plus the version.
11. **Supply chain**: OCI labels (`source`, `revision`), hadolint as a `make lint` step, an image scan in CI, multi-arch only on release. Detail: [SUPPLY_CHAIN.md](references/SUPPLY_CHAIN.md).
12. **Compose is for local development and tests only**, split by purpose: `compose.yaml` plus override files.

## Gotchas

- An `ARG` before the first `FROM` is in scope for `FROM` lines only; redeclare `ARG name` inside the stage to use it.
- `apt-get update`, `apt-get install --no-install-recommends` and the `rm -rf /var/lib/apt/lists/*` cleanup go in one `RUN`, or the cleanup saves nothing and a stale index gets cached.
- `COPY . .` before the install step invalidates the dependency cache on every source edit.
- `COPY` as root leaves files root-owned: use `COPY --chown=10001:10001`.
- The build context is sent in full before the first instruction: a missing `.dockerignore` makes every build slow and can bake in `.env`.
- Compose names a project after its directory, so each worktree gets its own containers, networks and volumes: `docker compose down --volumes` before its worktree goes. BuildKit's cache is the builder's and already shared, so never export a build cache into the worktree (`--cache-to type=local,dest=./...`): `host-hygiene`, Shared stores.
- Cache mounts and secret mounts need BuildKit; not every builder (older daemons, some CI or cloud builders) supports them. Check before relying on them.
- A value used in `RUN --mount=type=secret` is absent from the image; the same value in `ENV` or `ARG` is not.

## References

Load only what the task needs.

- [BUILD.md](references/BUILD.md): stages, monorepo context, cache, tags, compose layout.
- [RUNTIME.md](references/RUNTIME.md): user, signals, health, config, resource limits.
- [SUPPLY_CHAIN.md](references/SUPPLY_CHAIN.md): pinning, labels, hadolint, scanning, multi-arch.

## Owned elsewhere

- Static Go binary flags: `go-development`.
