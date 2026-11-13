#!/usr/bin/env bash
# A repo with commitlint and a husky commit-msg hook.
set -euo pipefail
mkdir -p .husky
cat > commitlint.config.js <<'JS'
module.exports = { extends: ['@commitlint/config-conventional'] };
JS
cat > .husky/commit-msg <<'SH'
#!/usr/bin/env sh
npx --no -- commitlint --edit "$1"
SH
chmod +x .husky/commit-msg
cat > package.json <<'JSON'
{
  "name": "app",
  "devDependencies": {
    "@commitlint/cli": "^19.0.0",
    "@commitlint/config-conventional": "^19.0.0",
    "husky": "^9.0.0"
  }
}
JSON
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
