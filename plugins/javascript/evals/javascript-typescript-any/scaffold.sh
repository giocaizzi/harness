#!/usr/bin/env bash
# A small TypeScript package whose src/api.ts is full of any types.
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
cat > src/api.ts <<'TS'
export async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function parseUser(raw: any): any {
  return { id: raw.id, name: raw.name, email: raw.email };
}

export async function getUser(id: number): Promise<any> {
  const raw = await fetchJson(`https://api.example.com/users/${id}`);
  return parseUser(raw);
}

export function groupByRole(users: any[]): Record<string, any[]> {
  const out: Record<string, any[]> = {};
  for (const u of users) {
    (out[u.role] ??= []).push(u);
  }
  return out;
}
TS
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
