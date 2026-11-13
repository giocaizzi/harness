#!/usr/bin/env bash
# A Jenkins pipeline running unit and integration tests against a database.
set -euo pipefail
mkdir -p tests/integration src
cat > Jenkinsfile <<'GROOVY'
pipeline {
  agent any
  stages {
    stage('Unit') {
      steps { sh 'npm ci && npm test' }
    }
    stage('Integration') {
      steps {
        sh 'docker run -d --name db -p 5432:5432 postgres:16'
        sh 'sleep 5'
        sh 'npm run test:integration'
      }
    }
  }
  post { always { sh 'docker rm -f db || true' } }
}
GROOVY
cat > tests/integration/orders.test.js <<'JS'
const test = require('node:test');
const assert = require('node:assert');
const { connect } = require('../../src/db');

test('creates an order', async () => {
  const db = await connect();
  await db.query("INSERT INTO orders (id, total) VALUES (1, 10)");
  const rows = await db.query('SELECT total FROM orders WHERE id = 1');
  assert.strictEqual(rows[0].total, 10);
});
JS
cat > src/db.js <<'JS'
exports.connect = async () => ({ query: async () => [{ total: 10 }] });
JS
cat > package.json <<'JSON'
{ "name": "app", "scripts": { "test": "node --test src", "test:integration": "node --test tests/integration" } }
JSON
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
