# TypeScript: boundaries

One toolset, the one the `atomic-design` skill picks: `eslint-plugin-import-x` `no-restricted-paths` for per-file direction (or `eslint-plugin-boundaries` when there are many element types), `dependency-cruiser` for cycles and the graph, ESLint core `no-restricted-imports` for chokepoints. Do not add a second boundary tool. For UI levels and the shared setup, messages and exception handling, read the enforcement reference of `atomic-design`.

## Backend layer zones

Same rule, different zones. In the flat config, with `import-x`:

```js
const src = "./src";
export default [
  {
    rules: {
      "import-x/no-restricted-paths": ["error", { zones: [
        { target: `${src}/domain`, from: [`${src}/services`, `${src}/http`, `${src}/db`],
          message: "The domain imports nothing above it. Declare an interface in domain and implement it in db." },
        { target: `${src}/services`, from: `${src}/http`,
          message: "Services never import the transport layer. Return values and let http translate." },
      ] }],
    },
  },
];
```

Graph rules (no cycles, no module reaching into another module's internals) go in `.dependency-cruiser.cjs`, run from a `make` target (`depcruise src`) included in `check`:

```js
{ name: "no-cross-module", severity: "error",
  from: { path: "^src/modules/([^/]+)/" },
  to: { path: "^src/modules/", pathNot: ["^src/modules/$1/", "^src/modules/[^/]+/index\\.ts$"] },
  comment: "Import another module only through its index.ts." }
```

Existing violations: ESLint bulk suppressions, in RATCHETS.md.
