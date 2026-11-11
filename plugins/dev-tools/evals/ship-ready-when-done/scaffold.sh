#!/usr/bin/env bash
# A pushed feature branch with a passing make check, a draft PR whose title describes older work, and a stand-in gh.
set -euo pipefail
echo "# app" > README.md
printf 'check:\n\t@echo checks passed\n' > Makefile
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
git init -q --bare .origin.git
printf '.origin.git/\n' >> .git/info/exclude
git remote add origin ./.origin.git
git push -q origin main
git switch -q -c feat/usage
echo "Run with app --help or app --version." >> README.md
git -c user.name=eval -c user.email=eval@example.com commit -qam "docs: document --help and --version"
git push -q -u origin feat/usage
mkdir -p bin
cat > bin/gh <<'SH'
#!/usr/bin/env bash
# Stand-in for the gh CLI: logs every call and answers the few the task needs.
echo "gh $*" >> "$(dirname "$0")/../.gh-calls"
case "$1 $2" in
  "pr list") echo '[{"number":3,"isDraft":true,"title":"docs: document --help","headRefName":"feat/usage"}]' ;;
  "pr view") echo '{"number":3,"isDraft":true,"state":"OPEN","title":"docs: document --help","body":"Documents --help.","headRefName":"feat/usage"}' ;;
  "repo view") echo '{"visibility":"PRIVATE"}' ;;
  *) ;;
esac
SH
chmod +x bin/gh
printf 'bin/\n.gh-calls\n' >> .git/info/exclude
