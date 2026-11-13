#!/usr/bin/env bash
# A repo tagged v1.7.0 with five commits since, plus a v1.8.0 tag on the last one.
set -euo pipefail
echo "# acme-cli" > README.md
echo "v1" > cli.txt
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm "feat: initial release"
git tag v1.7.0
i=0
for msg in "feat: add --json output flag" "fix: exit non-zero when the config file is missing" "fix: stop truncating long names in the table view" "docs: document the --json flag" "perf: cache the config lookup"; do
  i=$((i + 1))
  echo "change $i" >> cli.txt
  git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm "$msg"
done
git tag v1.8.0
