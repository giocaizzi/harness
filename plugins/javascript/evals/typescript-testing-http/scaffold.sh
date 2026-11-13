#!/usr/bin/env bash
# A TypeScript package with a fetchUser HTTP client and no tests yet.
set -euo pipefail
cat > package.json <<'JSON'
{
  "name": "acme-lib",
  "private": true,
  "type": "module",
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "devDependencies": { "typescript": "^5.6.0", "vitest": "^3.0.0" }
}
JSON
cat > tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
JSON
mkdir -p src
cat > src/client.ts <<'TS'
export type User = { id: number; name: string };

export async function fetchUser(id: number): Promise<User> {
  const res = await fetch(`https://api.example.com/users/${id}`);
  if (res.status === 404) throw new Error("user not found");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as User;
}
TS
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
