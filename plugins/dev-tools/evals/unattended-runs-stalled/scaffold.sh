#!/usr/bin/env bash
# A repo whose overnight script runs claude -p on TODO.md.
set -euo pipefail
mkdir -p scripts
cat > scripts/overnight.sh <<'T'
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
claude -p "$(cat TODO.md)"
T
chmod +x scripts/overnight.sh
cat > TODO.md <<'T'
- Bump the lint config to the latest ruleset.
- Fix every failing unit test.
T
echo '# app' > README.md
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
