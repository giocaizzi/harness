#!/usr/bin/env bash
# A small GitLab CI pipeline with build, test and staging deploy jobs.
set -euo pipefail
cat > .gitlab-ci.yml <<'YML'
stages: [build, test, deploy]

build:
  stage: build
  image: node:22
  script:
    - npm ci
    - npm run build
  artifacts:
    paths: [dist/]

test:
  stage: test
  image: node:22
  script:
    - npm ci
    - npm test

deploy-staging:
  stage: deploy
  script:
    - ./scripts/deploy.sh staging
  environment: staging
YML
mkdir -p scripts
printf '#!/usr/bin/env bash\necho "deploying to $1"\n' > scripts/deploy.sh
chmod +x scripts/deploy.sh
cat > package.json <<'JSON'
{ "name": "app", "version": "1.0.0", "scripts": { "build": "node build.js", "test": "node --test" } }
JSON
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
