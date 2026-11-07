#!/usr/bin/env bash
# A tiny Node TypeScript package with a retry helper and no tests.
set -euo pipefail
mkdir -p src/retry
cat > package.json <<'JSON'
{ "name": "svc", "private": true, "type": "module", "packageManager": "pnpm@12.18.0", "scripts": { "build": "tsc", "test": "vitest run" }, "devDependencies": { "typescript": "npm:@typescript/typescript6@^6.0.2", "@typescript/native": "npm:typescript@^7.0.2", "@types/node": "^22.19.0", "vitest": "^5.1.0" } }
JSON
cat > tsconfig.json <<'JSON'
{ "compilerOptions": { "target": "es2024", "lib": ["es2024"], "module": "nodenext", "moduleResolution": "nodenext", "types": ["node"], "rootDir": ".", "noEmit": true, "strict": true, "noUncheckedIndexedAccess": true, "verbatimModuleSyntax": true }, "include": ["src"] }
JSON
cat > src/retry/retry.ts <<'TS'
/** Marks an error that retrying will not fix. */
export class PermanentError extends Error {
  override readonly name = 'PermanentError';
}

/** Calls fn up to attempts times, doubling the delay after each failure. */
export async function retry<T>(fn: () => Promise<T>, attempts: number, signal: AbortSignal): Promise<T> {
  let delayMs = 100;
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e: unknown) {
      lastError = e;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('aborted', {cause: signal.reason}));
      }, {once: true});
    });
    delayMs *= 2;
  }
  throw new Error(`gave up after ${String(attempts)} attempts`, {cause: lastError});
}
TS
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
