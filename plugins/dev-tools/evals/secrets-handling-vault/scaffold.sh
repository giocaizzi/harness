#!/usr/bin/env bash
# A deploy script with a hardcoded placeholder password.
set -euo pipefail
printf '#!/usr/bin/env bash\nDB_PASSWORD="changeme"\necho "deploying"\n' > deploy.sh
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
