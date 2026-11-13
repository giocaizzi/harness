#!/usr/bin/env bash
# A feature branch with two modified files and a gh stand-in.
set -euo pipefail
mkdir -p app
echo 'def greet(name):
    return "hi " + name' > app/greet.py
echo '# app' > README.md
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
git switch -q -c feat/greeting
echo 'def shout(name):
    return greet(name).upper()' >> app/greet.py
echo 'Greets people.' >> README.md
mkdir -p bin
cat > bin/gh <<'SH'
#!/usr/bin/env bash
# Stand-in for the gh CLI: logs every call and answers the few the task needs.
echo "gh $*" >> "$(dirname "$0")/../.gh-calls"
case "$1 $2" in
  "pr list") echo "[]" ;;
  "pr create") echo "https://example.com/acme/app/pull/1" ;;
  "repo view") echo '{"visibility":"PRIVATE"}' ;;
  *) ;;
esac
SH
chmod +x bin/gh
printf 'bin/\n.gh-calls\n' >> .git/info/exclude
