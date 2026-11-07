#!/usr/bin/env bash
# A tiny Go HTTP client with no retry.
set -euo pipefail
cat > go.mod <<'MOD'
module example.com/orders

go 1.23
MOD
cat > client.go <<'GO'
package orders

import (
	"net/http"
	"time"
)

var httpClient = &http.Client{Timeout: 5 * time.Second}

func Fetch(url string) (*http.Response, error) {
	return httpClient.Get(url)
}
GO
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
