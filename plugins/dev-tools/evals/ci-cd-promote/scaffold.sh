#!/usr/bin/env bash
# An Azure Pipelines file that builds the same image separately for staging and production.
set -euo pipefail
cat > azure-pipelines.yml <<'YML'
trigger:
  branches:
    include: [main]

pool:
  vmImage: ubuntu-latest

stages:
  - stage: Staging
    jobs:
      - job: BuildAndDeployStaging
        steps:
          - script: docker build -t acme.azurecr.io/app:staging .
            displayName: Build image
          - script: docker push acme.azurecr.io/app:staging
            displayName: Push image
          - script: ./deploy.sh staging acme.azurecr.io/app:staging
            displayName: Deploy to staging
  - stage: Production
    dependsOn: Staging
    jobs:
      - job: BuildAndDeployProduction
        steps:
          - script: docker build -t acme.azurecr.io/app:prod .
            displayName: Build image
          - script: docker push acme.azurecr.io/app:prod
            displayName: Push image
          - script: ./deploy.sh production acme.azurecr.io/app:prod
            displayName: Deploy to production
YML
cat > Dockerfile <<'DOCKER'
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
CMD ["node", "server.js"]
DOCKER
printf '#!/usr/bin/env bash\necho "deploy $1 $2"\n' > deploy.sh
chmod +x deploy.sh
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
