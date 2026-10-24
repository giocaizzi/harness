#!/usr/bin/env bash
# A Go poller with a test that sleeps and uses testify.
set -euo pipefail
mkdir -p internal/poll
cat > go.mod <<'MOD'
module example.com/tool

go 1.27.0

require github.com/stretchr/testify v1.11.1
MOD
cat > internal/poll/poll.go <<'GO'
// Package poll calls a check on an interval until it reports done.
package poll

import (
	"context"
	"time"
)

// Poller runs Check every Interval.
type Poller struct {
	Interval time.Duration
	Check    func(context.Context) (bool, error)
}

// Run blocks until Check returns true, an error, or ctx ends.
func (p *Poller) Run(ctx context.Context) error {
	t := time.NewTicker(p.Interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
			done, err := p.Check(ctx)
			if err != nil || done {
				return err
			}
		}
	}
}
GO
cat > internal/poll/poll_test.go <<'GO'
package poll

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestPoller(t *testing.T) {
	calls := 0
	p := &Poller{Interval: 50 * time.Millisecond, Check: func(context.Context) (bool, error) {
		calls++
		return calls == 3, nil
	}}
	go p.Run(context.Background())
	time.Sleep(160 * time.Millisecond)
	require.Equal(t, 3, calls)
}
GO
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
