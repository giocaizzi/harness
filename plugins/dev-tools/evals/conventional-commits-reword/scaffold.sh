#!/usr/bin/env bash
# A small repo whose last commit, 'fixed stuff', adds a missing null check.
set -euo pipefail
c() { git -c user.name=eval -c user.email=eval@example.com commit -qm "$1"; }
mkdir -p src
cat > src/user.js <<'JS'
function displayName(user) {
  return user.name.trim();
}
module.exports = { displayName };
JS
git init -q && git add -A && c "feat: add displayName"
cat > src/user.js <<'JS'
function displayName(user) {
  if (!user || user.name == null) return "anonymous";
  return user.name.trim();
}
module.exports = { displayName };
JS
git add -A && c "fixed stuff"
