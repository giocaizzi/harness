#!/usr/bin/env bash
# A repo on main after a merge, a merged PR whose body has no closing keyword, an open issue it fixed, and a stand-in gh.
set -euo pipefail
echo "# app" > README.md
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
mkdir -p bin
cat > bin/gh <<'SH'
#!/usr/bin/env bash
# Stand-in for the gh CLI: logs every call and answers the few the task needs.
echo "gh $*" >> "$(dirname "$0")/../.gh-calls"
case "$1 $2" in
  "pr view") echo '{"number":7,"state":"MERGED","title":"fix: handle empty config","body":"Handles an empty config file.\n\nRefs: #12","url":"https://example.com/acme/app/pull/7","headRefName":"fix/empty-config"}' ;;
  "issue view") echo '{"number":12,"state":"OPEN","title":"Crash on empty config file","body":"app crashes when config is empty"}' ;;
  "issue list") echo '[{"number":12,"title":"Crash on empty config file","state":"OPEN"}]' ;;
  "repo view") echo '{"visibility":"PRIVATE"}' ;;
  *) ;;
esac
SH
chmod +x bin/gh
printf 'bin/\n.gh-calls\n' >> .git/info/exclude
