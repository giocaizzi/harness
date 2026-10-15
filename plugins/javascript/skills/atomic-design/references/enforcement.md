# Enforcing component architecture

## Pick the tool

| Rule | Tool |
|---|---|
| Direction between levels and layers, per file, in the editor | `eslint-plugin-import-x` `no-restricted-paths`, or `eslint-plugin-boundaries` when there are many element types |
| Cycles, sibling features, anything the whole graph decides | `dependency-cruiser` in `make check` and CI |
| Chokepoints (`fetch`, SDKs, icons, palette) | ESLint core `no-restricted-imports` / `no-restricted-syntax`, scoped with flat-config `files` and `ignores` |
| Feature-Sliced Design layout | Steiger |
| Public API of a workspace package | `package.json` `exports` |

Prefer rules that match resolved files over path-string globs: a relative import slips past a glob written for the `@/` alias. Keep graph rules in dependency-cruiser so they survive a move to oxlint or Biome.

## Messages are instructions

Every rule carries a `message` (dependency-cruiser: `comment`) that says what to do instead and where it lives. Coding agents read it as their next step: "Atoms cannot import molecules. Move the shared part down into an atom, or compose it in the molecule."

## Direction in ESLint

```js
// eslint.config.js
import importX from "eslint-plugin-import-x";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";

const ui = "./src/components/ui";
export default [
  {
    plugins: { "import-x": importX },
    settings: { "import-x/resolver-next": [createTypeScriptImportResolver()] },
    rules: {
      "import-x/no-restricted-paths": ["error", { zones: [
        { target: `${ui}/atoms`, from: [`${ui}/molecules`, `${ui}/organisms`], message: "Atoms cannot import molecules or organisms. Move the shared part into an atom." },
        { target: `${ui}/molecules`, from: `${ui}/organisms`, message: "Molecules cannot import organisms. Compose them in the organism instead." },
        { target: ui, from: ["./src/features", "./src/app", "./src/lib/api"], message: "The UI kit takes props only. Fetch in the feature or route and pass the data down." },
      ] }],
    },
  },
];
```

## Graph rules in dependency-cruiser

```js
// .dependency-cruiser.cjs
module.exports = {
  forbidden: [
    { name: "no-circular", severity: "error", from: {}, to: { circular: true },
      comment: "Break the cycle: move the shared code into a lower layer." },
    { name: "no-cross-feature", severity: "error",
      from: { path: "^src/features/([^/]+)/" },
      to: { path: "^src/features/", pathNot: "^src/features/$1/" },
      comment: "Features cannot import each other. Share through components/ui or lib." },
    { name: "no-test-in-prod", severity: "error",
      from: { pathNot: "\\.(test|spec|stories)\\.[jt]sx?$" },
      to: { path: "\\.(test|spec|stories)\\.[jt]sx?$" },
      comment: "Production code cannot import tests or stories." },
  ],
};
```

Run it from a `make` target (`depcruise src`), included in `check`.

## Existing violations

- Turn a new rule on as `error` at once. Record what already breaks with ESLint bulk suppressions (`eslint --suppress-all`, committed `eslint-suppressions.json`, ESLint 9.24+), so new violations fail and old ones are visible in one file. Run `eslint --prune-suppressions` as they get fixed.
- No inline `eslint-disable` for architecture rules. Set `linterOptions.reportUnusedDisableDirectives: "error"` so stale exemptions fail.
- A rule that flags reasonable code is wrong: fix or drop the rule rather than suppress it file by file.

## Where each check runs

- Per-file ESLint rules run on save and in an after-edit agent hook: they are cheap.
- dependency-cruiser, `import-x/no-cycle` and Steiger walk the graph: run them in `make check`, pre-push or CI, not on every edit.
- Prefer barrel-free public APIs (`exports`, an `internal/` folder convention) over `index.ts` re-exports; barrels slow builds, tests and lint.
