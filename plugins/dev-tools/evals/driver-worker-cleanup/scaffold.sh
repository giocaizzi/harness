#!/usr/bin/env bash
# A driver branch with a bare origin, and a worker unit committed on a local branch in its own worktree.
set -euo pipefail
echo "# app" > README.md
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
git init -q --bare .origin.git
printf '.origin.git/\n' >> .git/info/exclude
git remote add origin ./.origin.git
git push -q origin main
git switch -q -c feat/export
git push -q -u origin feat/export
git worktree add -q .claude/worktrees/unit-csv -b worker/unit-csv feat/export
echo "id,name" > .claude/worktrees/unit-csv/export_csv.txt
git -C .claude/worktrees/unit-csv add -A
git -C .claude/worktrees/unit-csv -c user.name=eval -c user.email=eval@example.com commit -qm "feat: add csv exporter"
printf '.claude/\n' >> .git/info/exclude
cat > WORKER_REPORT.md <<'MD'
# Worker report

Did: added export_csv.txt (CSV exporter stub).
Commits: one, "feat: add csv exporter", on branch worker/unit-csv.
Worktree: .claude/worktrees/unit-csv
Checks: none defined in this repo.
Stopped on: nothing.
MD
printf 'WORKER_REPORT.md\n' >> .git/info/exclude
