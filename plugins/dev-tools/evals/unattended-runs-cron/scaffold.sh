#!/usr/bin/env bash
# A repo with a scripts/ directory and a TRIAGE.md describing the triage.
set -euo pipefail
mkdir -p scripts
cat > TRIAGE.md <<'T'
# Issue triage

1. List issues opened in the last 24 hours.
2. Label each as bug, feature or question.
3. Comment on duplicates with a link to the original.
T
cat > scripts/list_issues.sh <<'T'
#!/usr/bin/env bash
gh issue list --state open --limit 50
T
chmod +x scripts/list_issues.sh
echo '# app' > README.md
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
