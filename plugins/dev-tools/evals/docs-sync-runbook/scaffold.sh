#!/usr/bin/env bash
# A repo with one existing runbook and a rotate-db-password script.
set -euo pipefail
mkdir -p docs/runbooks scripts
cat > docs/runbooks/restore-backup.md <<'MD'
# Restore a database backup

1. List backups: `scripts/list-backups.sh`.
2. Restore the chosen one: `scripts/restore-backup.sh <backup-id>`.
3. Check the app: `curl -f https://app.example.com/health`.
MD
cat > scripts/rotate-db-password.sh <<'SH'
#!/usr/bin/env bash
# Generates a new password, sets it on the database and updates the secret store.
set -euo pipefail
new="$(openssl rand -base64 24)"
psql "$DATABASE_ADMIN_URL" -c "ALTER ROLE app PASSWORD '$new'"
secret-store put acme/app/db-password "$new"
echo "rotated; restart the app to pick it up"
SH
chmod +x scripts/rotate-db-password.sh
printf '# app\n\nRunbooks live in [docs/runbooks](docs/runbooks).\n' > README.md
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
