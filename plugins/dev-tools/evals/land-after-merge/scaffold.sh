#!/usr/bin/env bash
# A repo with a bare origin where feat/x was merged into origin main, local main behind, and a stand-in gh.
set -euo pipefail
echo "# app" > README.md
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
git init -q --bare .origin.git
printf '.origin.git/\n' >> .git/info/exclude
git remote add origin ./.origin.git
git push -q origin main
git switch -q -c feat/x
echo "Run with app --help." >> README.md
git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm "docs: add usage"
git push -q origin feat/x
git switch -q main
git -c user.name=eval -c user.email=eval@example.com merge -q --no-ff feat/x -m "docs: add usage (#3)"
git push -q origin main
git reset -q --hard HEAD~1
git switch -q feat/x
mkdir -p bin
cat > bin/gh <<'SH'
#!/usr/bin/env bash
# Stand-in for the gh CLI: logs every call and answers the few the task needs.
echo "gh $*" >> "$(dirname "$0")/../.gh-calls"
case "$1 $2" in
  "pr view") echo '{"number":3,"state":"MERGED","title":"docs: add usage","body":"Adds a usage line.","url":"https://example.com/acme/app/pull/3","headRefName":"feat/x"}' ;;
  "pr list") echo '[{"number":3,"state":"MERGED","headRefName":"feat/x"}]' ;;
  "repo view") echo '{"visibility":"PRIVATE"}' ;;
  *) ;;
esac
SH
chmod +x bin/gh
printf 'bin/\n.gh-calls\n' >> .git/info/exclude
