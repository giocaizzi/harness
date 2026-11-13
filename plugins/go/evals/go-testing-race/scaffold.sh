#!/usr/bin/env bash
# A Go cache package with an unsynchronised map and a concurrent test.
set -euo pipefail
mkdir -p cache
cat > go.mod <<'M'
module example.com/acme/app

go 1.26
M
cat > cache/cache.go <<'G'
package cache

type Cache struct {
	data map[string]int
}

func New() *Cache {
	return &Cache{data: map[string]int{}}
}

func (c *Cache) Set(k string, v int) {
	c.data[k] = v
}

func (c *Cache) Get(k string) (int, bool) {
	v, ok := c.data[k]
	return v, ok
}
G
cat > cache/cache_test.go <<'G'
package cache

import (
	"fmt"
	"sync"
	"testing"
)

func TestCacheConcurrent(t *testing.T) {
	c := New()
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			k := fmt.Sprintf("k%d", i)
			c.Set(k, i)
			c.Get(k)
		}()
	}
	wg.Wait()
}
G
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
