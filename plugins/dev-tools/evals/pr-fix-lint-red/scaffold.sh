#!/usr/bin/env bash
# A repo on a PR branch with a ruff error and a stand-in gh showing the lint check failing.
set -euo pipefail
mkdir -p app
cat > app/report.py <<'PY'
import os
import sys


def render(rows):
    return "\n".join(f"{name}: {count}" for name, count in rows)


def main():
    print(render([("open", 3), ("closed", 5)]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
PY
cat > pyproject.toml <<'TOML'
[project]
name = "acme-report"
version = "0.1.0"

[tool.ruff]
line-length = 100
TOML
cat > Makefile <<'MK'
lint:
	ruff check .
MK
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
git switch -q -c feat/report
mkdir -p bin
cat > bin/gh <<'SH'
#!/usr/bin/env bash
# Stand-in for the gh CLI: logs every call and answers the few the task needs.
echo "gh $*" >> "$(dirname "$0")/../.gh-calls"
case "$1 $2" in
  "pr view") echo '{"number":15,"state":"OPEN","title":"feat: add report","url":"https://example.com/acme/app/pull/15","headRefName":"feat/report","reviewDecision":"","comments":[],"reviews":[]}' ;;
  "pr checks") printf 'lint\tfail\t9s\thttps://example.com/acme/app/actions/runs/31\ntest\tpass\t18s\thttps://example.com/acme/app/actions/runs/32\n' ;;
  "run view") printf 'lint\tRun ruff\napp/report.py:1:8: F401 [*] `os` imported but unused\nFound 1 error.\n##[error]Process completed with exit code 1.\n' ;;
  "run list") echo '[{"databaseId":31,"name":"lint","status":"completed","conclusion":"failure","headBranch":"feat/report"}]' ;;
  "repo view") echo '{"visibility":"PRIVATE"}' ;;
  *) ;;
esac
SH
chmod +x bin/gh
printf 'bin/\n.gh-calls\n' >> .git/info/exclude
