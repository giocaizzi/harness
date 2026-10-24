#!/usr/bin/env bash
# A tiny Go module with a retry loop and a permanent-error sentinel.
set -euo pipefail
mkdir -p internal/retry
cat > go.mod <<'MOD'
module example.com/tool

go 1.27.0
MOD
cat > internal/retry/retry.go <<'GO'
// Package retry retries a call with exponential backoff.
package retry

import (
	"context"
	"errors"
	"time"
)

// ErrPermanent marks an error that retrying will not fix.
var ErrPermanent = errors.New("permanent")

// Retry calls f up to attempts times, doubling the delay after each failure.
func Retry(ctx context.Context, attempts int, f func(context.Context) error) error {
	delay := 100 * time.Millisecond
	var err error
	for range attempts {
		if err = f(ctx); err == nil {
			return nil
		}
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			return ctx.Err()
		}
		delay *= 2
	}
	return err
}
GO
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
