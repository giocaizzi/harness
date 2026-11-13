#!/usr/bin/env bash
# A small TypeScript package whose formatDate mishandles ISO strings with a timezone offset.
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
cat > src/format.ts <<'TS'
export function formatDate(iso: string): string {
  const [datePart] = iso.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const time = iso.split("T")[1]?.replace(/Z$/, "") ?? "00:00:00";
  const d = new Date(year, month - 1, day, ...time.split(":").map(Number));
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
TS
cat > src/format.test.ts <<'TS'
import { expect, test } from "vitest";
import { formatDate } from "./format";

test("formats a Z timestamp", () => {
  expect(formatDate("2026-03-05T10:00:00Z")).toBe("05 Mar 2026");
});
TS
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
