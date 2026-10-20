#!/usr/bin/env bash
# A tiny Go module that runs a command with exec.Command and no timeout or tree kill.
set -euo pipefail
mkdir -p internal/runner
cat > go.mod <<'MOD'
module example.com/tool

go 1.27.0
MOD
cat > internal/runner/runner.go <<'GO'
// Package runner runs one command.
package runner

import "os/exec"

// Run runs name with args and returns its combined output.
func Run(name string, args ...string) ([]byte, error) {
	return exec.Command(name, args...).CombinedOutput()
}
GO
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
