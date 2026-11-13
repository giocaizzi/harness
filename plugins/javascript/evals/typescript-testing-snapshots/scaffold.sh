#!/usr/bin/env bash
# A TypeScript package whose snapshots embed timestamps and random ids.
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
mkdir -p src/__snapshots__
cat > src/report.ts <<'TS'
export function buildReport(title: string) {
  return {
    id: Math.random().toString(36).slice(2),
    title,
    generatedAt: new Date().toISOString(),
    rows: [{ label: "total", value: 42 }],
  };
}
TS
cat > src/report.test.ts <<'TS'
import { expect, test } from "vitest";
import { buildReport } from "./report";

test("report matches snapshot", () => {
  expect(buildReport("Q1")).toMatchSnapshot();
});

test("report with another title matches snapshot", () => {
  expect(buildReport("Q2")).toMatchSnapshot();
});
TS
cat > src/__snapshots__/report.test.ts.snap <<'SNAP'
// Vitest Snapshot v1

exports[`report matches snapshot 1`] = `
{
  "generatedAt": "2026-01-01T00:00:00.000Z",
  "id": "k3j9x0a1b2",
  "rows": [
    {
      "label": "total",
      "value": 42,
    },
  ],
  "title": "Q1",
}
`;
SNAP
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
