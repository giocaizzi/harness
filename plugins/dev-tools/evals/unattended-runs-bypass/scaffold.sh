#!/usr/bin/env bash
# A small Python repo with lint errors.
set -euo pipefail
mkdir -p app
cat > pyproject.toml <<'T'
[project]
name = "acme-app"
version = "0.1.0"

[tool.ruff]
line-length = 88
T
cat > app/util.py <<'P'
import os
import sys

def  helper( x ):
    unused = 1
    return x+1
P
cat > app/main.py <<'P'
from app.util import *

def main():
    print( helper(2) )
P
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
