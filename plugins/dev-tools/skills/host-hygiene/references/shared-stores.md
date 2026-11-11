# Shared stores

Where each ecosystem keeps its per-user store, and what stays in a worktree. The rule is in `SKILL.md`; `node repo-sweep.mjs --stores` reports sizes and trim commands.

| Item | Per-user store (default) | Override | What stays in the worktree | Safe trim | Notes |
|---|---|---|---|---|---|
| Go build cache | `os.UserCacheDir()/go-build` (macOS `~/Library/Caches/go-build`, Linux `$XDG_CACHE_HOME/go-build` or `~/.cache/go-build`, Windows `%LocalAppData%\go-build`) | `GOCACHE` (absolute, or `off`) | Nothing | `go clean -cache` | Safe for many processes on one machine, not on a network filesystem. Go trims entries unused for 5 days, scanning at most daily. Without `-trimpath` the key of a package built from a local dir includes that absolute dir, so worktrees do not share compiled packages of the main module (module-cache dependencies are shared either way); with `-trimpath` they do. Test results are a separate cache (`go clean -testcache`). |
| Go module cache | `$GOPATH/pkg/mod` (GOPATH default `~/go`) | `GOMODCACHE` | Nothing | `go clean -modcache`, only when no go command runs; refetches over the network | Files are read-only (`-modcacherw` makes new dirs writable). Downloaded toolchains (`GOTOOLCHAIN=auto`) are modules (`golang.org/toolchain`) fetched like any other. |
| Go tools | The build cache | `GOCACHE` | The tool directive in `go.mod` (or `-modfile=<file>.mod` for an isolated tool module) | Build cache trim | `go tool <name>` (Go 1.24+) and `go run pkg@version` executables are cached in the build cache: rebuilt once per toolchain, shared by every worktree. |
| golangci-lint | Analysis cache `golangci-lint` under Go's user cache dir | `GOLANGCI_LINT_CACHE` (absolute) | Nothing | `golangci-lint cache clean`; size: `golangci-lint cache status` | Its install script without `-b` installs to `./bin/`: pass `-b <per-user dir>/<version>`. Upstream recommends the prebuilt binary and does not recommend `go tool` (the `go-development` skill accepts it in its own modfile). |
| Prebuilt tool binaries | Per-user cache dir (`$XDG_CACHE_HOME` or `~/.cache` on Linux, `~/Library/Caches` on macOS, `%LocalAppData%` on Windows) `/<tool>/<version>/` | A make variable the environment overrides | Nothing | Delete version dirs no repo pins | Download into a temp dir beside the target, then rename. |
| envtest (setup-envtest) | macOS `~/Library/Application Support/io.kubebuilder.envtest`; Linux `$XDG_DATA_HOME/kubebuilder-envtest` or `~/.local/share/kubebuilder-envtest`; Windows `%LocalAppData%\kubebuilder-envtest` (the tool's help says `envtest-binaries`, the code uses these) | `--bin-dir` only (no env var); `ENVTEST_INSTALLED_ONLY` = `-i`, `ENVTEST_USE_ENV` | `KUBEBUILDER_ASSETS` points at the store (`setup-envtest use <v> -p path` prints it) | `setup-envtest cleanup <version>` | Layout `k8s/<version>-<os>-<arch>`: one copy per Kubernetes patch version and platform. Files are read-only (0555). `use` is not atomic: fetch once before fanning out. |
| npm | `~/.npm` (`_cacache`); Windows `%LocalAppData%\npm-cache` | `cache` config, `npm_config_cache` | `node_modules`, a full copy per worktree | `npm cache verify` (garbage-collects) | npm says `npm cache clean --force` is rarely needed: the cache self-heals. |
| pnpm | Content-addressable store linked into `node_modules`: `$PNPM_HOME/store`, else `$XDG_DATA_HOME/pnpm/store`, else macOS `~/Library/pnpm/store`, Linux `~/.local/share/pnpm/store`, Windows `~/AppData/Local/pnpm/store` | `storeDir` setting; `pnpm store path` prints the active one | `node_modules` of links | `pnpm store prune` (unreferenced packages, refetched when needed), when no install runs | `packageImportMethod` `auto`: macOS clone, Linux and Windows hardlink, falling back to copy. The store must be on the same filesystem as the worktrees, otherwise pnpm copies (and a disk without a home dir gets a store at its root). `enableGlobalVirtualStore` (off by default) would share `node_modules` contents too but has caveats (ESM and `NODE_PATH` need a loader hook): not adopted here. |
| Playwright browsers | macOS `~/Library/Caches/ms-playwright`, Linux `~/.cache/ms-playwright`, Windows `%USERPROFILE%\AppData\Local\ms-playwright` | `PLAYWRIGHT_BROWSERS_PATH` (never `0`: it installs into `node_modules` per worktree) | Nothing | `npx playwright uninstall` (this installation's browsers; `--all` every installation's) | Playwright deletes browser versions no installed client needs, unless `PLAYWRIGHT_SKIP_BROWSER_GC=1`. |
| uv | `$XDG_CACHE_HOME/uv` or `~/.cache/uv`; Windows `%LOCALAPPDATA%\uv\cache` | `UV_CACHE_DIR` | `.venv`, linked from the cache (`UV_LINK_MODE`; default clone on macOS and Linux, hardlink on Windows) | `uv cache prune` (unused entries), `uv cache clean` | Safe for concurrent uv processes. Prune and clean wait on the cache lock (`UV_LOCK_TIMEOUT`, 5 min): never `--force` with other uv commands running. The `.venv` is cheap only when the cache is on the same filesystem; otherwise uv copies. uv-managed Pythons live in `~/.local/share/uv/python` (`UV_PYTHON_INSTALL_DIR`). |
| Rust | `CARGO_HOME` (`~/.cargo`) registry and git caches | `CARGO_HOME` | `target`, per worktree | Cargo auto-cleans since 1.88 (download caches unused 3 months, regenerable 1 month; `cache.auto-clean-frequency`) | One shared `CARGO_TARGET_DIR` makes concurrent builds wait on its lock. Share compiled crates through sccache instead: `RUSTC_WRAPPER=sccache`, `SCCACHE_DIR` (default `~/.cache/sccache`, macOS `~/Library/Caches/Mozilla.sccache`, Windows `%LOCALAPPDATA%\Mozilla\sccache`), capped by `SCCACHE_CACHE_SIZE` (10G default). |
| Docker | BuildKit's cache belongs to the builder and is reused by every build on it, from any worktree | `RUN --mount=type=cache` for package caches (`sharing=locked` serialises parallel builds) | Never export a cache into the worktree (`--cache-to type=local,dest=./...`) | `docker builder prune --filter until=<duration>` (or `--reserved-space` / `--max-used-space`); automatic GC via `defaultKeepStorage` (Docker Desktop: 20GB) | Compose names a project after its directory unless `-p`, `COMPOSE_PROJECT_NAME` or a top-level `name:` is set, so each worktree gets its own containers, networks and volumes: `docker compose down --volumes` before its worktree goes. |

## Low disk: what is safe to delete

Cheapest first:

1. Go build cache: `go clean -cache`.
2. golangci-lint cache: `golangci-lint cache clean`.
3. `uv cache prune`.
4. `npm cache verify`.
5. `pnpm store prune`.
6. Unused Playwright browsers: `npx playwright uninstall`.
7. `docker builder prune --filter until=<duration>`.
8. Unused envtest versions: `setup-envtest cleanup <version>`.
9. Go module cache last (`go clean -modcache`): it refetches over the network.

**Never** delete another session's worktree, a store in the middle of being written, or uv-managed Pythons that venvs use.

## Checked against

- https://pkg.go.dev/cmd/go
- https://go.dev/ref/mod
- https://go.dev/doc/go1.24
- https://go.dev/doc/toolchain
- https://go.dev/src/cmd/go/internal/work/exec.go
- https://golangci-lint.run/docs/configuration/cli/
- https://golangci-lint.run/docs/welcome/install/local/
- https://github.com/kubernetes-sigs/controller-runtime/tree/main/tools/setup-envtest
- https://docs.npmjs.com/cli/v11/commands/npm-cache
- https://pnpm.io/settings/store
- https://pnpm.io/settings/node-modules
- https://pnpm.io/cli/store
- https://playwright.dev/docs/browsers
- https://docs.astral.sh/uv/concepts/cache/
- https://docs.astral.sh/uv/reference/storage/
- https://doc.rust-lang.org/cargo/reference/config.html
- https://github.com/mozilla/sccache/blob/main/docs/Local.md
- https://docs.docker.com/build/cache/garbage-collection/
- https://docs.docker.com/reference/cli/docker/buildx/prune/
- https://docs.docker.com/compose/how-tos/project-name/

Checked 2026-11.
