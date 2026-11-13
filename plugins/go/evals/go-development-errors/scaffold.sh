#!/usr/bin/env bash
# A small Go module whose LoadConfig returns bare 'failed' errors.
set -euo pipefail
mkdir -p config
cat > go.mod <<'M'
module example.com/acme/app

go 1.26
M
cat > config/config.go <<'G'
package config

import (
	"encoding/json"
	"errors"
	"os"
)

type Config struct {
	Addr    string `json:"addr"`
	Workers int    `json:"workers"`
}

func LoadConfig(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, errors.New("failed")
	}
	var c Config
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, errors.New("failed")
	}
	if c.Addr == "" || c.Workers < 1 {
		return nil, errors.New("failed")
	}
	return &c, nil
}
G
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
