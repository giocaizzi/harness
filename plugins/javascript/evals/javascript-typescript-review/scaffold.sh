#!/usr/bin/env bash
# A Node TypeScript repo with a retry helper full of casts.
set -euo pipefail
mkdir -p src
cat > package.json <<'JSON'
{ "name": "svc", "private": true, "type": "module", "scripts": { "build": "tsc" }, "devDependencies": { "typescript": "^5.9.0", "@types/node": "^24.0.0" } }
JSON
cat > tsconfig.json <<'JSON'
{ "compilerOptions": { "target": "ES2022", "module": "NodeNext", "strict": true, "outDir": "dist" }, "include": ["src"] }
JSON
cat > src/retry.ts <<'TS'
export async function retry(fn: any, times: number = 3): Promise<any> {
  let lastErr;
  for (let i = 0; i < times; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e as Error;
      await new Promise((r) => setTimeout(r, 100 * i));
    }
  }
  // eslint-disable-next-line
  throw new Error("retry failed: " + lastErr!.message);
}
TS
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
