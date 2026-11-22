#!/usr/bin/env bash
# A value-free export of a vault: names and folders only.
set -euo pipefail
cat > vault-export.json <<'J'
[{"name":"GITHUB_SSH_KEY_ME","folder":null,"type":5},
 {"name":"db_pw_admin_dev","folder":"Projects","type":1},
 {"name":"release_please_pem","folder":null,"type":1},
 {"name":"acme-release-please GitHub App private key","folder":null,"type":2},
 {"name":"Cloudflare token (new)","folder":"Misc","type":1},
 {"name":"[dev] TF_VAR_API_TOKEN","folder":"Projects","type":1}]
J
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
