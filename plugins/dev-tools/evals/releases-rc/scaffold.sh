#!/usr/bin/env bash
# A library at 2.4.0 with a changelog and a v2.4.0 tag, and no release automation.
set -euo pipefail
mkdir -p acme_lib
echo '__version__ = "2.4.0"' > acme_lib/__init__.py
cat > pyproject.toml <<'TOML'
[project]
name = "acme-lib"
version = "2.4.0"
TOML
printf '# Changelog\n\n## 2.4.0\n\n- Add batch API\n\n## 2.3.0\n\n- Add retry option\n' > CHANGELOG.md
echo "# acme-lib" > README.md
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm "release 2.4.0"
git tag v2.4.0
echo "# new client" >> acme_lib/__init__.py
git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm "Replace the client with an async one (breaking)"
