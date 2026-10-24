#!/usr/bin/env bash
# A Node TypeScript service with a deploy shell script.
set -euo pipefail
mkdir -p src scripts
cat > package.json <<'JSON'
{ "name": "svc", "private": true, "type": "module", "scripts": { "build": "tsc" }, "devDependencies": { "typescript": "^5.9.0", "@types/node": "^24.0.0" } }
JSON
cat > tsconfig.json <<'JSON'
{ "compilerOptions": { "target": "ES2022", "module": "NodeNext", "strict": true, "outDir": "dist" }, "include": ["src"] }
JSON
cat > src/index.ts <<'TS'
export const version = "1.0.0";
TS
cat > scripts/deploy.sh <<'SH'
#!/bin/sh
npm ci
npm run build
tar czf app.tgz dist package.json
scp app.tgz deploy@app.example.com:/srv/app/
ssh deploy@app.example.com 'cd /srv/app && tar xzf app.tgz && systemctl restart app'
SH
chmod +x scripts/deploy.sh
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
