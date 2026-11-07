# Project setup

Everything below ran end to end (Nov 2026) on a library package with pnpm 12.18, TypeScript 7.0.2 beside TypeScript 6.0.3, ESLint 10.14, typescript-eslint 8.72, Prettier 3.9, Vitest 5.1, knip 6.44 and zod 4.6: `make fmt`, `make check`, `make build`, and importing `dist/` from Node.

## Layout

```
.
├── package.json             type: module, packageManager, engines, exports, scripts
├── pnpm-lock.yaml           committed; CI installs with --frozen-lockfile
├── pnpm-workspace.yaml      pnpm settings (and packages: in a monorepo)
├── .node-version            26: the Node apps and CI run on
├── tsconfig.json            from tsconfig.node.json (or tsconfig.bundler.json for a bundled app)
├── tsconfig.build.json      libraries only: emit dist/ with isolatedDeclarations
├── eslint.config.js         from eslint.config.js
├── .prettierrc.json  .prettierignore
├── vitest.config.ts         from the typescript-testing skill
├── knip.json                apps only: {"entry": ["src/main.ts"]}
├── Makefile
└── src/
    ├── index.ts             the package's public API, nothing else
    ├── main.ts              apps: argv/env, composition root, exit code
    ├── <feature>/           snake_case files, tests beside them (*.test.ts)
    └── testing/             fakes shared by several features' tests
```

## package.json

```json
{
  "name": "@acme/payments",
  "version": "0.0.0",
  "type": "module",
  "packageManager": "pnpm@12.18.0",
  "engines": {"node": ">=22.18"},
  "exports": {".": {"types": "./dist/index.d.ts", "default": "./dist/index.js"}},
  "files": ["dist"],
  "scripts": {
    "fmt": "prettier --write . && eslint --fix .",
    "lint": "prettier --check . && eslint --max-warnings=0 . && tsc --noEmit && tsc --noEmit -p tsconfig.build.json && knip",
    "test": "vitest run --project unit --coverage",
    "test-integration": "vitest run --project integration",
    "build": "tsc -p tsconfig.build.json"
  },
  "dependencies": {"zod": "^4.6.7"},
  "devDependencies": {
    "@eslint/js": "^10.0.1",
    "@types/node": "^22.19.0",
    "@typescript/native": "npm:typescript@^7.0.2",
    "@vitest/coverage-v8": "^5.1.0",
    "@vitest/eslint-plugin": "^1.6.28",
    "eslint": "^10.14.0",
    "eslint-config-prettier": "^10.1.8",
    "eslint-plugin-jsdoc": "^65.4.5",
    "eslint-plugin-n": "^18.5.0",
    "eslint-plugin-unicorn": "^79.0.0",
    "fast-check": "^4.10.2",
    "knip": "^6.44.2",
    "msw": "^3.0.4",
    "prettier": "^3.9.10",
    "typescript": "npm:@typescript/typescript6@^6.0.2",
    "typescript-eslint": "^8.72.1",
    "vitest": "^5.1.0"
  }
}
```

- `@types/node` matches the `engines` floor, not the Node you develop on, so the types never offer an API the oldest supported Node lacks; `n/no-unsupported-features/node-builtins` checks the same against `engines`.
- An app (`"private": true`) drops `exports`, `files` and `tsconfig.build.json`, takes `engines.node` from `.node-version` and runs `node dist/main.js`.
- `exports` with `types` first and no `main`: ESM only. Add `@arethetypeswrong/cli` (`attw --pack --profile esm-only`) to `lint` before the first publish.

## Prettier

`.prettierrc.json`, Google's settings as `gts` ships them:

```json
{"bracketSpacing": false, "singleQuote": true, "trailingComma": "all", "arrowParens": "avoid"}
```

`.prettierignore`: `pnpm-lock.yaml` (Prettier skips `node_modules` and the `.gitignore`d `dist/` and `coverage/` itself).

## tsconfig

- Code Node runs (services, CLIs, libraries): [tsconfig.node.json](./tsconfig.node.json) as `tsconfig.json`. It type-checks `src/` and the config files with `noEmit`; `make build` emits through `tsconfig.build.json`.
- Libraries: [tsconfig.build.json](./tsconfig.build.json) adds `isolatedDeclarations` (declarations without type inference, so every export carries its type) and excludes tests. `lint` type-checks it too, because it is stricter than the root project.
- Apps a bundler builds: [tsconfig.bundler.json](./tsconfig.bundler.json) (`module: preserve`, `moduleResolution: bundler`, `noEmit`, the DOM libs). Put the bundler's client types in `types` (`"vite/client"`). Next.js writes its own `tsconfig.json`: keep its `plugins`, `paths` and `include`, and add the strictness flags from this file.
- A monorepo gets one `tsconfig.base.json` with the compiler options and a `tsconfig.json` per package that extends it; `composite` and project references only when `tsc --build` times show the need.

## pnpm-workspace.yaml

pnpm's settings go here, not in `.npmrc`. A single package needs no entries; pnpm writes `minimumReleaseAgeExclude` here itself when you add a release younger than the one-day default. Dependency install scripts do not run unless listed (`pnpm approve-builds`).

## Makefile

```makefile
# The commands live in package.json scripts (knip reads them); make is the surface CI calls.
PNPM := pnpm --silent

.PHONY: help install fmt lint test test-integration check build

help: ## List targets
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | sed 's/:.*##/\t/'

install: ## Install exactly what the lockfile says
	pnpm install --frozen-lockfile

fmt: ## Format, then apply lint autofixes
	$(PNPM) run fmt

lint: ## Format check, ESLint, type check (app and build projects), knip
	$(PNPM) run lint

test: ## Unit and type tests once, with coverage
	$(PNPM) run test

test-integration: ## Tests against real services (*.int.test.ts); CI runs them
	$(PNPM) run test-integration

check: lint test ## lint + test

build: ## Emit dist/ (JS, .d.ts, maps)
	$(PNPM) run build
```

`.gitignore`: `node_modules/`, `dist/`, `coverage/`.

## CI

One `ci.yml`, jobs aggregated by `check` (org standard).

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6          # reads packageManager
      - uses: actions/setup-node@v7
        with:
          node-version-file: .node-version
          cache: pnpm
      - run: make install
      - run: make check
```

A library also runs `make test` on the `engines` floor (`node-version: 22`) in a matrix, so an API newer than the floor fails CI instead of a user. Add `test` to `check.needs`.

## Dependabot

```yaml
  - package-ecosystem: npm               # covers pnpm-lock.yaml
    directory: /
    schedule:
      interval: weekly
    commit-message:
      prefix: "chore(deps)"
    groups:
      minor-patch: {update-types: [minor, patch]}
      major: {update-types: [major]}
      security: {applies-to: security-updates, patterns: ["*"]}
    ignore:
      - dependency-name: "typescript"      # the TypeScript 6 alias for linters: bump by hand
        update-types: ["version-update:semver-major"]
```

A typescript-eslint or ESLint major goes in its own PR, with the new findings fixed there.
