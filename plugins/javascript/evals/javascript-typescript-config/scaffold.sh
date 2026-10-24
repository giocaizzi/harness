#!/usr/bin/env bash
# A small Node TypeScript service with a config file it never reads.
set -euo pipefail
mkdir -p src
cat > package.json <<'JSON'
{ "name": "svc", "private": true, "type": "module", "scripts": { "build": "tsc" }, "devDependencies": { "typescript": "^5.9.0", "@types/node": "^24.0.0" } }
JSON
cat > tsconfig.json <<'JSON'
{ "compilerOptions": { "target": "ES2022", "module": "NodeNext", "strict": true, "outDir": "dist" }, "include": ["src"] }
JSON
cat > config.json <<'JSON'
{ "port": 8080, "databaseUrl": "postgres://localhost/app" }
JSON
cat > src/server.ts <<'TS'
import { createServer } from "node:http";

const server = createServer((_req, res) => {
  res.end("ok");
});

server.listen(8080);
TS
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
