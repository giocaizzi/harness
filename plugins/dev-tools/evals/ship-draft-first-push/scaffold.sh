#!/usr/bin/env bash
# A repo with a bare origin, a feature branch with an uncommitted change and a stand-in gh.
set -euo pipefail
echo "# app" > README.md
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
git init -q --bare .origin.git
printf '.origin.git/\n' >> .git/info/exclude
git remote add origin ./.origin.git
git push -q origin main
git switch -q -c feat/usage
echo "Run with app --help." >> README.md
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
