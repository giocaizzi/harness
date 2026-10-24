#!/usr/bin/env bash
# A plain Express API in TypeScript, no front end.
set -euo pipefail
mkdir -p src
cat > package.json <<'JSON'
{ "name": "api", "version": "2.3.0", "private": true, "type": "module",
  "dependencies": { "express": "^5.1.0" },
  "devDependencies": { "typescript": "^5.9.0", "@types/express": "^5.0.0" } }
JSON
cat > src/app.ts <<'TS'
import express from "express";

export const app = express();

app.get("/users", (_req, res) => {
  res.json([{ id: 1, name: "Ada" }]);
});
TS
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
