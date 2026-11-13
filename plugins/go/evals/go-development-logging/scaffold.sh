#!/usr/bin/env bash
# A small Go service using log.Printf in a worker and main.
set -euo pipefail
mkdir -p cmd/acme internal/worker
cat > go.mod <<'M'
module example.com/acme/app

go 1.26
M
cat > cmd/acme/main.go <<'G'
package main

import (
	"log"

	"example.com/acme/app/internal/worker"
)

func main() {
	log.Printf("starting acme with %d workers", 4)
	if err := worker.Run(4); err != nil {
		log.Printf("worker failed: %v", err)
	}
}
G
cat > internal/worker/worker.go <<'G'
package worker

import (
	"errors"
	"log"
)

func Run(n int) error {
	if n < 1 {
		return errors.New("need at least one worker")
	}
	for i := 0; i < n; i++ {
		log.Printf("worker %d started", i)
	}
	return nil
}
G
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
