#!/usr/bin/env bash
# A Go package with a hand-written ParseDuration that can panic.
set -euo pipefail
mkdir -p dur
cat > go.mod <<'M'
module example.com/acme/app

go 1.26
M
cat > dur/dur.go <<'G'
package dur

import (
	"errors"
	"strconv"
	"time"
)

// ParseDuration parses strings such as "5m" or "1h30m".
func ParseDuration(s string) (time.Duration, error) {
	var total time.Duration
	for i := 0; i < len(s); {
		j := i
		for s[j] >= '0' && s[j] <= '9' {
			j++
		}
		n, err := strconv.Atoi(s[i:j])
		if err != nil {
			return 0, err
		}
		switch s[j] {
		case 's':
			total += time.Duration(n) * time.Second
		case 'm':
			total += time.Duration(n) * time.Minute
		case 'h':
			total += time.Duration(n) * time.Hour
		default:
			return 0, errors.New("unknown unit")
		}
		i = j + 1
	}
	return total, nil
}
G
cat > dur/dur_test.go <<'G'
package dur

import (
	"testing"
	"time"
)

func TestParseDuration(t *testing.T) {
	got, err := ParseDuration("5m")
	if err != nil || got != 5*time.Minute {
		t.Fatalf("got %v, %v", got, err)
	}
}
G
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
