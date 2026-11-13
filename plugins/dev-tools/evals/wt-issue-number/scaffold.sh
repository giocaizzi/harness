#!/usr/bin/env bash
# A small repo with a gh stand-in that returns issue 57.
set -euo pipefail
mkdir -p app
cat > app/export.py <<'P'
def export(items):
    return ",".join(items[0:1]) + "\n" + ",".join(items[1:])
P
echo '# app' > README.md
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
mkdir -p bin
cat > bin/gh <<'SH'
#!/usr/bin/env bash
# Stand-in for the gh CLI: logs every call and answers issue 57.
echo "gh $*" >> "$(dirname "$0")/../.gh-calls"
case "$1 $2" in
  "issue view") echo '{"number":57,"title":"Export fails on empty list","body":"export([]) raises IndexError.","state":"OPEN"}' ;;
  "repo view") echo '{"visibility":"PRIVATE"}' ;;
  *) ;;
esac
SH
chmod +x bin/gh
printf 'bin/\n.gh-calls\n' >> .git/info/exclude
