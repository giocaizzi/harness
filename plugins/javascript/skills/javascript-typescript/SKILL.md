---
name: javascript-typescript
description: "House rules for TypeScript, JavaScript and Node.js: strict typing, no any, casts, non-null assertions or eslint-disable, the tsconfig baseline, ES modules and node: imports. Use whenever you write, change or review .ts or .js code, whether adding a function or feature, fixing a bug, refactoring or reviewing before a merge, even when the user does not mention conventions."
---

# JavaScript/TypeScript

- TypeScript with `strict` on. Type definitions and constants live in `types.ts` / `constants.ts` inside their feature folder, so types stay next to the code they describe.
- JSDoc on public functions (purpose, params, returns, errors). Comments explain why, not what; keep them short.
- Tooling: `eslint` + `prettier` (quality/format), `knip` (unused deps/exports), `tsc` (type check).
- Navigate code by symbol with the LSP tool where you have one (definitions, references, callers, type errors) before grep; grep for text, config and languages without a language server.

## Type-safety escape hatches are off limits

Do not use `any`, `eslint-disable`, or type assertions/casts (`as`, `as const` for typing, `!`). They silence the checker instead of fixing the model; narrow with type guards, discriminated unions, generics or `unknown` + validation instead.

## tsconfig baseline

`noUncheckedIndexedAccess` and `noImplicitOverride` go beyond `strict` and are part of the baseline.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "skipLibCheck": true,
    "declaration": true,
    "outDir": "./dist"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

## Node.js

- Use ES modules and the `node:` prefix for built-ins (`import { readFile } from 'node:fs/promises'`).
- Register a `process.on('unhandledRejection')` handler that logs and exits non-zero, so failures crash loudly instead of leaving a half-working process.

## Gotchas

- `noUncheckedIndexedAccess` types `arr[i]` and `record[key]` as `T | undefined`. Narrow with a check or use `.at()` plus a guard; a `!` to silence it is the banned escape hatch.
- The baseline's `moduleResolution: "bundler"` suits code a bundler builds. Code Node runs straight from `tsc` output needs `module` and `moduleResolution` set to `NodeNext` and a `.js` extension on every relative import in the `.ts` source; without them it compiles and then fails at runtime with `ERR_MODULE_NOT_FOUND`.
- `catch (e)` gives `unknown` under `strict`: narrow with `instanceof Error` before reading `.message`.
