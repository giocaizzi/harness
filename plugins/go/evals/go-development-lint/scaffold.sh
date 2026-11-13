#!/usr/bin/env bash
# A small Go module with a Makefile and no golangci-lint config.
set -euo pipefail
mkdir -p internal/store
cat > go.mod <<'M'
module example.com/acme/app

go 1.26
M
cat > Makefile <<'M'
.PHONY: build test

build:
	go build ./...

test:
	go test ./...
M
cat > internal/store/store.go <<'G'
package store

import "fmt"

type Store struct {
	items map[string]string
}

func New() *Store {
	return &Store{items: map[string]string{}}
}

func (s *Store) Put(k, v string) {
	s.items[k] = v
}

func (s *Store) Get(k string) string {
	v, ok := s.items[k]
	if !ok {
		fmt.Println("missing key", k)
	}
	return v
}
G
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
