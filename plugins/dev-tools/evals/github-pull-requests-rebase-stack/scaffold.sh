#!/usr/bin/env bash
# A repo where part-1 is merged into main, part-2 sits on part-1 and part-3 on part-2, with a stand-in gh.
set -euo pipefail
c() { git -c user.name=eval -c user.email=eval@example.com commit -qm "$1"; }
git init -q -b main
printf '# app\n' > README.md
git add -A && c init
git switch -q -c part-1
echo one > one.txt && git add -A && c "feat: part 1"
git switch -q -c part-2
echo two > two.txt && git add -A && c "feat: part 2"
git switch -q -c part-3
echo three > three.txt && git add -A && c "feat: part 3"
git switch -q main
git merge -q --squash part-1 && c "feat: part 1 (#1)"
git switch -q part-3
mkdir -p bin
cat > bin/gh <<'SH'
#!/usr/bin/env bash
# Stand-in for the gh CLI: logs every call and answers the few the task needs.
echo "gh $*" >> "$(dirname "$0")/../.gh-calls"
case "$1 $2" in
  "pr list") echo '[{"number":2,"headRefName":"part-2","baseRefName":"part-1","isDraft":false},{"number":3,"headRefName":"part-3","baseRefName":"part-2","isDraft":false}]' ;;
  "pr create") echo "https://example.com/acme/app/pull/1" ;;
  "repo view") echo '{"visibility":"PRIVATE"}' ;;
  *) ;;
esac
SH
chmod +x bin/gh
printf 'bin/\n.gh-calls\n' >> .git/info/exclude
