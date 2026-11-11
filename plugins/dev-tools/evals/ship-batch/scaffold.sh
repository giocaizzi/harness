#!/usr/bin/env bash
# An open PR of the same user already changes docs/usage.md; no local worktree holds its branch.
set -euo pipefail
mkdir -p docs bin
echo "# Usage" > docs/usage.md
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
git init -q --bare .origin.git
printf '.origin.git/\n' >> .git/info/exclude
git remote add origin ./.origin.git
git push -q origin main
git switch -q -c feat/docs-usage
echo "Run with app --help." >> docs/usage.md
git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm "docs: add help line"
git push -q -u origin feat/docs-usage
git switch -q main
git branch -q -D feat/docs-usage
cat > bin/gh <<'SH'
#!/usr/bin/env bash
# Stand-in for the gh CLI: logs every call, lists one open PR, answers the rest.
echo "gh $*" >> "$(dirname "$0")/../.gh-calls"
case "$1 $2" in
  "pr list") echo '[{"number":7,"headRefName":"feat/docs-usage","isDraft":true,"files":[{"path":"docs/usage.md"}]}]' ;;
  "pr create") echo "https://example.com/acme/app/pull/8" ;;
  "repo view") echo '{"visibility":"PRIVATE"}' ;;
  *) ;;
esac
SH
chmod +x bin/gh
printf 'bin/\n.gh-calls\n' >> .git/info/exclude
