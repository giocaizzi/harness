#!/usr/bin/env bash
# A tiny Go module that processes items one by one.
set -euo pipefail
mkdir -p internal/batch
cat > go.mod <<'MOD'
module example.com/tool

go 1.27.0
MOD
cat > internal/batch/batch.go <<'GO'
// Package batch processes a batch of items.
package batch

import "context"

// Process calls handle for each item in order.
func Process(ctx context.Context, items []string, handle func(context.Context, string) error) error {
	for _, it := range items {
		if err := handle(ctx, it); err != nil {
			return err
		}
	}
	return nil
}
GO
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
