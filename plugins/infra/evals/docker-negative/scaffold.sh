#!/usr/bin/env bash
# A tiny Go HTTP service with no container setup.
set -euo pipefail
mkdir -p cmd/orders
cat > go.mod <<'MOD'
module example.com/acme/orders

go 1.26
MOD
cat > cmd/orders/main.go <<'GO'
package main

import (
	"fmt"
	"net/http"
)

func main() {
	http.HandleFunc("/orders", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintln(w, "[]")
	})
	_ = http.ListenAndServe(":8080", nil)
}
GO
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
