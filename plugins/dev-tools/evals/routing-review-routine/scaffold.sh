#!/usr/bin/env bash
# A small library; the branch fixes typos in its README and a docstring.
set -euo pipefail
mkdir -p src
printf '# Slugify\n\nTurns titels into URL slugs. Instal it with pip and call slugify().\n' > README.md
printf 'def slugify(s):\n    """Retrun a lower-case slug."""\n    return "-".join(s.lower().split())\n' > src/slug.py
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
git checkout -qb docs/readme-typos
printf '# Slugify\n\nTurns titles into URL slugs. Install it with pip and call slugify().\n' > README.md
printf 'def slugify(s):\n    """Return a lower-case slug."""\n    return "-".join(s.lower().split())\n' > src/slug.py
git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm "docs: fix typos"
git checkout -q main
