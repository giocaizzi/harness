---
name: javascript-typescript
description: "Use whenever you write, change or review .ts, .tsx or .js code, a package.json, tsconfig.json or eslint.config.js, whether adding a function or feature, fixing a bug, refactoring, scaffolding a package or reviewing before a merge, even when the user does not mention conventions. House rules: TypeScript 7, Node 26, pnpm, ESLint 10, strict tsconfig, no any or enums, zod at the boundaries."
---

# TypeScript and Node.js

Baseline: the [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html); rules below add to it. What a tool enforces is specified by its config in `references/`; review the rest.

## Versions

- **TypeScript 7** (the native compiler: `tsc` from `typescript@7`) type-checks and emits. typescript-eslint cannot load TypeScript 7 until its API ships (7.1), so TypeScript 6 stays installed under the `typescript` name for linters and TypeScript 7 under an alias: `"typescript": "npm:@typescript/typescript6@^6.0.2"`, `"@typescript/native": "npm:typescript@^7.0.2"`. `tsc` runs 7; drop the alias once typescript-eslint supports 7.
- **Node**: apps run on the Active LTS (26) pinned in `.node-version`; libraries declare `engines.node` as the oldest supported LTS (`>=22.18` until Node 22 leaves support on 2027-04-30). ESM only (`"type": "module"`): CommonJS consumers can `require()` it.
- **pnpm**, pinned by `packageManager` (`pnpm@12.x.y`); pnpm switches itself to that version. Node 25+ no longer ships Corepack, so nothing relies on it. Keep pnpm's default `minimumReleaseAge` (one day). Each worktree's `node_modules` is links into pnpm's per-user store, so keep the store on the same filesystem as the worktrees; Playwright browsers stay in their per-user cache, never `PLAYWRIGHT_BROWSERS_PATH=0` (it installs them into `node_modules` per worktree): `host-hygiene`, Shared stores.

## Tooling

- **ESLint 10 flat config** from [references/eslint.config.js](./references/eslint.config.js): typescript-eslint `strictTypeChecked` + `stylisticTypeChecked` plus every Google rule a linter can check. A rule is turned off or loosened only in that file, with the reason on its line; `noInlineConfig` makes `eslint-disable` comments in source inert.
- **Prettier** with Google's settings (the ones `gts` ships), run as its own check. We don't depend on `gts` itself: its last release (7.0, Dec 2025) pins ESLint 9 and enables only typescript-eslint `recommended`.
- **tsconfig**: [references/tsconfig.node.json](./references/tsconfig.node.json) for code Node runs (`module: nodenext`), [references/tsconfig.bundler.json](./references/tsconfig.bundler.json) only for apps a bundler builds (Vite, Next.js); libraries add [references/tsconfig.build.json](./references/tsconfig.build.json) (`isolatedDeclarations`, emit to `dist/`).
- **knip** for unused files, exports and dependencies, in `lint`.
- **Make is the command surface**: `help`, `install`, `fmt`, `lint` (Prettier check, ESLint, `tsc` on both projects, knip), `test`, `test-integration`, `check` (= `lint` + `test`), `build`. The commands themselves live in `package.json` scripts, which knip reads.

Read [references/PROJECT_SETUP.md](./references/PROJECT_SETUP.md) when scaffolding: layout, `package.json`, Prettier, the Makefile, CI and Dependabot (the pipeline itself: `ci-cd`; on GitHub, `github-actions`).

## Stricter than Google, or left open by it

The Google rules most often missed are all in the ESLint config, so write them first time: named exports only (a default export only where a framework or tool loads one: Next.js `page`/`layout`, Storybook stories, `*.config.ts`); `snake_case` file names, components included (`user_card.tsx` exports `UserCard`); no `#private`, `namespace` or `const enum`; a `default` in every `switch`.

- **No escape hatches**: no `as T` or `<T>x`, no `!`, no `any`, no `@ts-ignore` or `@ts-expect-error` outside tests, no `eslint-disable`. Google allows the first three with a comment; we narrow instead (type guard, `instanceof`, a schema parse) and type literals with `satisfies` or an annotation. `as const` is not an assertion and is fine.
- **No `enum`** (Google allows plain ones): a union of string literals, or an `as const` array when the values are needed at runtime (`type Currency = (typeof CURRENCIES)[number]`).
- **Absence is `undefined`** in our own APIs (optional fields, `Map.get` style); `null` only where an external API hands it over.
- **Imports**: relative within a package, with the `.js` extension `nodenext` requires; `import type` for types (`verbatimModuleSyntax`); a namespace import for a large API (`import * as z from 'zod'`), named imports otherwise.
- **Return types** are written on a library's exports (`isolatedDeclarations` demands it) and inferred elsewhere.
- **Parameter properties**, as Google asks. That is why Node runs compiled `dist/`, not `.ts` through type stripping: `erasableSyntaxOnly` would forbid them.

## Design

- **Organize by feature** (`src/payments/`, `src/config/`), never by technical layer (`controllers/`, `services/`, `models/`, `utils/`). A package's public API is its `src/index.ts`; everything else is internal.
- **Abstract late.** Extract shared code on the third duplicate, not the second. No interface or abstract class for a single implementation unless a test needs the seam; then the consumer declares the interface it needs, next to the code that uses it, and the implementations satisfy it structurally (`implements` is documentation, not wiring).
- **Unions over hierarchies.** Variants of data are a discriminated union handled by an exhaustive `switch` (every case, plus Google's mandatory `default` assigning to `never`); a class hierarchy only where a framework demands one (`Error` subclasses).
- **Functions first.** A class when it holds state or dependencies across calls, taking them as constructor parameter properties. No pattern names in type names (`*Factory`, `*Manager`, `*Helper`, `Abstract*`) unless the type is that pattern.
- **Wiring**: dependencies come in through constructors and parameters, built once in `main` (the composition root). No DI container, no module-level singletons. Choosing among implementations is a `Map` or a `switch` built there, not a factory class.
- **Boundaries**: everything from outside (HTTP bodies, env, files, queues, `JSON.parse`) is `unknown` until a zod 4 schema parses it at the edge. Apps derive the type (`z.infer`); libraries declare the interface and annotate the schema (`z.ZodType<Config>`), because `isolatedDeclarations` cannot infer through a schema. A library that accepts a caller's schema takes a Standard Schema (`StandardSchemaV1`), not zod.
- **Errors**: return a discriminated union for outcomes the caller must branch on (declined, not found, invalid input); throw an `Error` (with `cause` when wrapping) for failures it cannot handle locally (bugs, I/O). No Result library.
- **Async**: every function that does I/O takes an `AbortSignal`; `fetch` gets `AbortSignal.any([signal, AbortSignal.timeout(ms)])`. Resources with `Symbol.asyncDispose` are held with `await using`.
- **Process**: `main.ts` reads argv and env, builds the dependencies, awaits `run()` and sets `process.exitCode`; nothing else calls `process.exit`. No `unhandledRejection` handler: Node already crashes with exit code 1, and a handler that only logs keeps a broken process alive.

Read [references/PATTERNS.md](./references/PATTERNS.md) for the exhaustive switch, a consumer-declared interface with two providers, boundary parsing, typed outcomes versus throws, `AbortSignal` plumbing and the `main`/`run` skeleton.

## Review what no tool checks

Google rules no linter covers: getters are pure; no arrow functions as class properties except event handlers that must be removed later; no `private static` methods (a module function instead); no new decorators; `parseInt` only for a non-decimal radix, after checking the digits; `try` blocks hold only the code that can throw; the simplest type that works (mapped and conditional types last); no return-type-only generics; names are descriptive, not abbreviated; JSDoc on methods whose purpose is not obvious; export only what other modules use.

## Gotchas

- `noUncheckedIndexedAccess` types `arr[i]` and `record[key]` as `T | undefined`. Narrow with a check; a `!` is the banned escape hatch.
- `exactOptionalPropertyTypes` rejects `{x: undefined}` for `x?: T`. Leave the key out (`...(v === undefined ? {} : {x: v})`), or declare `x?: T | undefined` where callers really pass `undefined`.
- Installing `typescript@7` under its own name crashes typescript-eslint, which imports the compiler API that 7.0 does not have: keep the alias above.
- TypeScript 6 and 7 changed defaults: `types` is `[]` (list `"node"`), `rootDir` is the tsconfig's directory, `strict` is on; `moduleResolution: node10`, `baseUrl` and `target: es5` are errors in 7. The baselines set each one explicitly.
- `.ts` import specifiers with `rewriteRelativeImportExtensions` fix the emitted JavaScript but leave `.ts` paths in the emitted `.d.ts`, which break for consumers. Libraries import with `.js`.
- A script run directly with `node script.ts` (type stripping, no type check) must use erasable syntax only: no parameter properties, no `enum`, no `namespace`. Keep such scripts tiny or compile them.
- `catch (e)` gives `unknown`: narrow with `instanceof Error` before reading `.message`.
- Adding a package published less than a day ago makes pnpm write a `minimumReleaseAgeExclude` entry to `pnpm-workspace.yaml`; review it like any dependency change and delete it once the release is a day old.
