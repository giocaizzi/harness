#!/usr/bin/env bash
# An Azure pipeline that deploys every branch to staging with no lock.
set -euo pipefail
cat > azure-pipelines.yml <<'YML'
trigger:
  branches:
    include: ['*']
stages:
  - stage: build
    jobs:
      - job: build
        steps:
          - script: make build
  - stage: deploy_staging
    dependsOn: build
    jobs:
      - job: deploy
        steps:
          - script: ./deploy.sh staging
YML
printf '#!/usr/bin/env bash\necho deploying to "$1"\n' > deploy.sh
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
