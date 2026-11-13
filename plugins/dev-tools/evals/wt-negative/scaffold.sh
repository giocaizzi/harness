#!/usr/bin/env bash
# A repo with a feature branch holding commits on top of main.
set -euo pipefail
echo '# app' > README.md
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
git switch -q -c feat/notes
echo 'notes' > NOTES.md && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm "docs: add notes"
echo 'more' >> NOTES.md && git -c user.name=eval -c user.email=eval@example.com commit -qam "docs: extend notes"
