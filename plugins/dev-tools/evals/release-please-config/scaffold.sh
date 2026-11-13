#!/usr/bin/env bash
# A repo with release-please-config.json and its manifest.
set -euo pipefail
printf '{\n  "packages": {\n    ".": {"release-type": "python", "package-name": "acme-app"}\n  }\n}\n' > release-please-config.json
printf '{".": "1.2.0"}\n' > .release-please-manifest.json
printf '[project]\nname = "acme-app"\nversion = "1.2.0"\n' > pyproject.toml
printf '# Changelog\n\n## 1.2.0\n\n* feat: export\n' > CHANGELOG.md
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm "feat: export"
