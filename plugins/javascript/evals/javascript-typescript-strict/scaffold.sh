#!/usr/bin/env bash
# A small TypeScript package with strict mode off and a few implicit-any spots.
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
    "strict": false,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
JSON
mkdir -p src
cat > src/total.ts <<'TS'
export function total(items) {
  let sum = 0;
  for (const item of items) sum += item.price * item.qty;
  return sum;
}

export function firstName(names: string[]) {
  return names[0].trim();
}
TS
cat > src/index.ts <<'TS'
import { total } from "./total";

console.log(total([{ price: 2, qty: 3 }]));
TS
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
