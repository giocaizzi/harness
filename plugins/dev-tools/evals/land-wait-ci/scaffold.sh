#!/usr/bin/env bash
# A repo on a feature branch with an open PR 9 whose checks are pending, and a stand-in gh.
set -euo pipefail
mkdir -p src
printf 'def greet(name):\n    return f"hello {name}"\n' > src/app.py
echo "# app" > README.md
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
git switch -q -c feat/greet
printf 'def shout(name):\n    return greet(name).upper()\n' >> src/app.py
git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm "feat: add shout"
mkdir -p bin
cat > bin/gh <<'SH'
#!/usr/bin/env bash
# Stand-in for the gh CLI: logs every call; checks are pending on the first call, then pass.
root="$(dirname "$0")/.."
echo "gh $*" >> "$root/.gh-calls"
case "$1 $2" in
  "pr view") echo '{"number":9,"state":"OPEN","isDraft":false,"title":"feat: add shout","body":"Adds shout().","url":"https://example.com/acme/app/pull/9","headRefName":"feat/greet","mergeStateStatus":"CLEAN"}' ;;
  "pr checks")
    n=$(cat "$root/.gh-checks-count" 2>/dev/null || echo 0)
    echo $((n + 1)) > "$root/.gh-checks-count"
    if [ "$n" -eq 0 ]; then printf 'test\tpending\t0\thttps://example.com/acme/app/actions/runs/1\nlint\tpass\t12s\thttps://example.com/acme/app/actions/runs/2\n'
    else printf 'test\tpass\t41s\thttps://example.com/acme/app/actions/runs/1\nlint\tpass\t12s\thttps://example.com/acme/app/actions/runs/2\n'; fi ;;
  "pr merge") echo "merged" ;;
  "repo view") echo '{"visibility":"PRIVATE"}' ;;
  *) ;;
esac
SH
chmod +x bin/gh
printf 'bin/\n.gh-calls\n.gh-checks-count\n' >> .git/info/exclude
