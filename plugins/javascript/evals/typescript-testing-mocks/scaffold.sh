#!/usr/bin/env bash
# A TypeScript package whose tests vi.mock the db module.
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
cat > src/db.ts <<'TS'
export type User = { id: number; name: string; active: boolean };

export async function findUser(id: number): Promise<User | undefined> {
  const rows: User[] = [{ id: 1, name: "Ada", active: true }];
  return rows.find((r) => r.id === id);
}

export async function saveUser(user: User): Promise<void> {
  console.log("saved", user.id);
}
TS
cat > src/users.ts <<'TS'
import { findUser, saveUser } from "./db";

export async function deactivate(id: number): Promise<boolean> {
  const user = await findUser(id);
  if (!user) return false;
  await saveUser({ ...user, active: false });
  return true;
}
TS
cat > src/users.test.ts <<'TS'
import { expect, test, vi } from "vitest";
import { deactivate } from "./users";
import { findUser, saveUser } from "./db";

vi.mock("./db");

test("deactivates an existing user", async () => {
  vi.mocked(findUser).mockResolvedValue({ id: 1, name: "Ada", active: true });
  expect(await deactivate(1)).toBe(true);
  expect(saveUser).toHaveBeenCalledWith({ id: 1, name: "Ada", active: false });
});

test("returns false for an unknown user", async () => {
  vi.mocked(findUser).mockResolvedValue(undefined);
  expect(await deactivate(2)).toBe(false);
  expect(saveUser).not.toHaveBeenCalled();
});
TS
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
