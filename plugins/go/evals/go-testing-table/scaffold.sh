#!/usr/bin/env bash
# A Go package with ParseSize and twelve near-identical tests.
set -euo pipefail
mkdir -p size
cat > go.mod <<'M'
module example.com/acme/app

go 1.26
M
cat > size/parse.go <<'G'
package size

import (
	"fmt"
	"strconv"
	"strings"
)

func ParseSize(s string) (int64, error) {
	s = strings.TrimSpace(strings.ToUpper(s))
	mult := int64(1)
	switch {
	case strings.HasSuffix(s, "KB"):
		mult, s = 1<<10, strings.TrimSuffix(s, "KB")
	case strings.HasSuffix(s, "MB"):
		mult, s = 1<<20, strings.TrimSuffix(s, "MB")
	case strings.HasSuffix(s, "GB"):
		mult, s = 1<<30, strings.TrimSuffix(s, "GB")
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("parse size %q: %w", s, err)
	}
	return n * mult, nil
}
G
{
echo 'package size'
echo
echo 'import "testing"'
i=0
for pair in "1:1" "10:10" "1KB:1024" "2KB:2048" "1MB:1048576" "3MB:3145728" "1GB:1073741824" " 5 :5" "7kb:7168" "0:0" "100KB:102400" "4GB:4294967296"; do
  i=$((i+1)); in=${pair%%:*}; out=${pair##*:}
  cat <<G

func TestParseSize$i(t *testing.T) {
	got, err := ParseSize("$in")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != $out {
		t.Errorf("ParseSize(%q) = %d, want %d", "$in", got, $out)
	}
}
G
done
} > size/parse_test.go
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
