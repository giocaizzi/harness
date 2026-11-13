#!/usr/bin/env bash
# A tiny CLI with argparse.
set -euo pipefail
printf 'import argparse\n\n\ndef main():\n    p = argparse.ArgumentParser()\n    p.add_argument("name")\n    print(p.parse_args().name)\n' > cli.py
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
