#!/usr/bin/env bash
# A tiny repo with a TODO list.
set -euo pipefail
printf -- '- [ ] add input validation\n- [ ] write the changelog\n- [ ] bump deps\n' > TODO.md
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
