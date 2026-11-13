#!/usr/bin/env bash
# A Go package with an HTTP Fetch client for an external API and no tests.
set -euo pipefail
mkdir -p client
cat > go.mod <<'M'
module example.com/acme/app

go 1.26
M
cat > client/client.go <<'G'
package client

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
)

type Client struct {
	BaseURL string
	HTTP    *http.Client
}

type Item struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func New() *Client {
	return &Client{BaseURL: "https://api.example.com", HTTP: http.DefaultClient}
}

func (c *Client) Fetch(ctx context.Context, id string) (*Item, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"/items/"+id, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch %s: %w", id, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetch %s: status %d", id, resp.StatusCode)
	}
	var it Item
	if err := json.NewDecoder(resp.Body).Decode(&it); err != nil {
		return nil, fmt.Errorf("decode %s: %w", id, err)
	}
	return &it, nil
}
G
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
