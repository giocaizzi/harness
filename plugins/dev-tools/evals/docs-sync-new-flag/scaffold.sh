#!/usr/bin/env bash
# A repo with a deploy script and a docs/deploy.md that documents its flags.
set -euo pipefail
mkdir -p scripts docs
cat > scripts/deploy.sh <<'SH'
#!/usr/bin/env bash
set -euo pipefail
env="${1:-staging}"
verbose=0
[[ "${2:-}" == "--verbose" ]] && verbose=1

[[ $verbose -eq 1 ]] && echo "deploying to $env"
rsync -a build/ "deploy@$env.example.com:/srv/app/"
ssh "deploy@$env.example.com" systemctl restart app
SH
chmod +x scripts/deploy.sh
cat > docs/deploy.md <<'MD'
# Deploying

Run `scripts/deploy.sh <env> [--verbose]`.

| Argument | Meaning |
|---|---|
| `<env>` | `staging` (default) or `production` |
| `--verbose` | Print the target before deploying |
MD
printf '# app\n\nSee [docs/deploy.md](docs/deploy.md) for deploying.\n' > README.md
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
