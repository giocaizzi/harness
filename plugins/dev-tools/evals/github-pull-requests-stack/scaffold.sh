#!/usr/bin/env bash
# A repo with branch feat/big holding three commits touching models/, api/ and ui/, and a stand-in gh.
set -euo pipefail
c() { git -c user.name=eval -c user.email=eval@example.com commit -qm "$1"; }
git init -q -b main
printf '# app\n' > README.md
git add -A && c init
git switch -q -c feat/big
mkdir -p models api ui
seq 1 500 | sed 's/^/field_/' > models/schema.txt
git add -A && c "feat: add models"
seq 1 500 | sed 's/^/route_/' > api/routes.txt
git add -A && c "feat: add api routes"
seq 1 500 | sed 's/^/view_/' > ui/views.txt
git add -A && c "feat: add ui views"
mkdir -p bin
cat > bin/gh <<'SH'
#!/usr/bin/env bash
# Stand-in for the gh CLI: logs every call and answers the few the task needs.
echo "gh $*" >> "$(dirname "$0")/../.gh-calls"
case "$1 $2" in
  "pr list") echo '[]' ;;
  "pr create") echo "https://example.com/acme/app/pull/1" ;;
  "repo view") echo '{"visibility":"PRIVATE"}' ;;
  *) ;;
esac
SH
chmod +x bin/gh
printf 'bin/\n.gh-calls\n' >> .git/info/exclude
