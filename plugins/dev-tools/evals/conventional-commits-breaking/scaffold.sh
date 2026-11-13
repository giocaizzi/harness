#!/usr/bin/env bash
# A CLI repo with a staged change that removes the --legacy flag.
set -euo pipefail
mkdir -p src
cat > src/cli.js <<'JS'
const args = process.argv.slice(2);
const legacy = args.includes('--legacy');
const verbose = args.includes('--verbose');

function run() {
  if (legacy) {
    console.log('running in legacy mode');
  }
  if (verbose) console.log('verbose on');
  console.log('done');
}
run();
JS
printf '# cli\n\nFlags: `--legacy`, `--verbose`.\n' > README.md
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
cat > src/cli.js <<'JS'
const args = process.argv.slice(2);
const verbose = args.includes('--verbose');

function run() {
  if (verbose) console.log('verbose on');
  console.log('done');
}
run();
JS
printf '# cli\n\nFlags: `--verbose`.\n' > README.md
git add -A
