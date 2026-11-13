#!/usr/bin/env bash
# A repo on a PR branch with two reviewer comments to address, and a stand-in gh returning them.
set -euo pipefail
cat > utils.py <<'PY'
def parse_port(value):
    return int(value)


def retry(fn, attempts=3):
    for _ in range(attempts):
        try:
            return fn()
        except Exception:
            pass
PY
cat > server.py <<'PY'
from utils import parse_port


def start(config):
    port = parse_port(config["port"])
    print(f"listening on {port}")
    return port
PY
echo "# server" > README.md
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
git switch -q -c feat/server
mkdir -p bin
cat > bin/gh <<'SH'
#!/usr/bin/env bash
# Stand-in for the gh CLI: logs every call and answers the few the task needs.
echo "gh $*" >> "$(dirname "$0")/../.gh-calls"
comments='[{"id":601,"path":"utils.py","line":2,"user":{"login":"reviewer"},"body":"parse_port should reject values outside 1-65535."},{"id":602,"path":"utils.py","line":10,"user":{"login":"reviewer"},"body":"retry swallows the last error. Re-raise it after the final attempt."}]'
case "$1 $2" in
  "pr view") echo '{"number":8,"state":"OPEN","title":"feat: start server","url":"https://example.com/acme/app/pull/8","headRefName":"feat/server","reviewDecision":"CHANGES_REQUESTED","comments":[],"reviews":[{"author":{"login":"reviewer"},"state":"CHANGES_REQUESTED","body":"Two inline comments, please address both."}]}' ;;
  "pr checks") printf 'test\tpass\t20s\thttps://example.com/acme/app/actions/runs/1\n' ;;
  "repo view") echo '{"visibility":"PRIVATE"}' ;;
  *) [ "$1" = api ] && echo "$comments" ;;
esac
SH
chmod +x bin/gh
printf 'bin/\n.gh-calls\n' >> .git/info/exclude
