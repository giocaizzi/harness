# Building images

## One file, named stages

One `Dockerfile` per deployable. Stages, in order:

| Stage | Purpose | Built by |
|---|---|---|
| `base` | pinned base, OS packages, non-root user, shared by the others | all |
| `deps` | dependency install from the lockfile (cache mount) | `dev`, `test`, `build` |
| `dev` | dev tools and live reload; source is bind-mounted by compose | `compose.override.yaml` (`build.target: dev`) |
| `test` | `deps` plus test tooling and source; runs the suite | CI (`--target test`) |
| `build` | compiles or bundles the artifact | `prod` |
| `prod` | minimal final image: artifact only, non-root, labels | CI release, the default last stage |

The last stage is the default target, so a bare `docker build` yields `prod`. Never ship `dev` or `test`.

## Layer order (cache)

1. Pinned base, OS packages (one `RUN`, `--no-install-recommends`, cleanup in the same layer).
2. Lockfile and manifest only, then the install with a cache mount: `RUN --mount=type=cache,target=<package cache dir>`.
3. Source (`COPY --chown=... src ./src`), copying only what the build reads, not `COPY . .`.
4. Build step, then the final stage `COPY --from=build`.

Rarely changing layers first, often changing last. `COPY --link` makes a copy independent of earlier layers, so changing a base layer does not rebuild it; use it in the final stage.

## Monorepo

Build context is the workspace root so shared packages and the root lockfile are reachable (`docker build -f services/orders/Dockerfile .`). The root `.dockerignore` is an allowlist:

```
*
!go.work
!go.mod
!go.sum
!libs/
!services/orders/
```

A new shared directory must be added to the allowlist; "file not found" in a `COPY` is the symptom.

## `.dockerignore`

Mandatory, at the context root. Always exclude `.git`, `.env*`, build output, `node_modules`, virtualenvs and test artifacts. Prefer the allowlist form for a monorepo.

## Tags and promotion

- Build once per commit; tag with the git SHA (`orders:<sha>`) and the version (`orders:1.4.2`) on release. No `latest`, no mutable environment tags (`staging`, `prod`).
- Promote by retagging or by deploying the same digest to the next environment; never rebuild per environment.
- Configuration (URLs, flags, credentials) is injected at runtime. An image that differs between environments is a bug.

## Compose

For local development and integration tests only; production runs on the orchestrator.

- `compose.yaml`: the services and their dependencies (database, queue), with no environment-specific values.
- `compose.override.yaml`: local dev, loaded automatically with `compose.yaml` (`dev` target, bind mounts, published ports).
- `compose.test.yaml`: the test setup, loaded explicitly: `docker compose -f compose.yaml -f compose.test.yaml up --abort-on-container-exit`. Passing `-f` disables the automatic override file.
- A later file overrides and merges into the earlier ones: scalars are replaced, lists such as `ports` are appended, mappings are merged. Check the result with `docker compose config`.
- Use `depends_on` with `condition: service_healthy` so the app waits for a real healthcheck.
