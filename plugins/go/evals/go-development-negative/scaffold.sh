#!/usr/bin/env bash
# A Go module with a Python changelog helper script.
set -euo pipefail
mkdir -p cmd/tool scripts
cat > go.mod <<'MOD'
module example.com/tool

go 1.27.0
MOD
cat > cmd/tool/main.go <<'GO'
package main

func main() {}
GO
cat > scripts/changelog.py <<'PY'
import subprocess


def main() -> None:
    log = subprocess.run(["git", "log", "--format=%s"], capture_output=True, text=True, check=True)
    for subject in log.stdout.splitlines():
        kind, text = subject.split(":", 1)
        print(f"- {kind}: {text.strip()}")


if __name__ == "__main__":
    main()
PY
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
