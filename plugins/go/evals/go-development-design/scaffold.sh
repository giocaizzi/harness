#!/usr/bin/env bash
# A Go reporter whose service depends directly on a concrete file store.
set -euo pipefail
mkdir -p cmd/reporter internal/report internal/filestore
cat > go.mod <<'MOD'
module example.com/reporter

go 1.27.0
MOD
cat > internal/filestore/filestore.go <<'GO'
// Package filestore keeps reports as files in a directory.
package filestore

import (
	"fmt"
	"os"
)

// Store keeps each report in its own file under a root directory.
type Store struct {
	root *os.Root
}

// Open returns a Store rooted at dir.
func Open(dir string) (*Store, error) {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, fmt.Errorf("open report store: %w", err)
	}
	return &Store{root: root}, nil
}

// Save writes the report body under id.
func (s *Store) Save(id string, body []byte) error {
	return s.root.WriteFile(id+".txt", body, 0o600)
}

// Load reads the report saved under id.
func (s *Store) Load(id string) ([]byte, error) {
	return s.root.ReadFile(id + ".txt")
}
GO
cat > internal/report/report.go <<'GO'
// Package report builds and stores reports.
package report

import (
	"fmt"
	"strings"

	"example.com/reporter/internal/filestore"
)

// Service builds reports and keeps them in a store.
type Service struct {
	store *filestore.Store
}

// NewService returns a Service that keeps reports in store.
func NewService(store *filestore.Store) *Service {
	return &Service{store: store}
}

// Build renders lines as a report and saves it under id.
func (s *Service) Build(id string, lines []string) error {
	if err := s.store.Save(id, []byte(strings.Join(lines, "\n"))); err != nil {
		return fmt.Errorf("save report %s: %w", id, err)
	}
	return nil
}

// Show returns the report saved under id.
func (s *Service) Show(id string) (string, error) {
	body, err := s.store.Load(id)
	if err != nil {
		return "", fmt.Errorf("load report %s: %w", id, err)
	}
	return string(body), nil
}
GO
cat > cmd/reporter/main.go <<'GO'
// Command reporter builds a report from its arguments and prints it back.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"

	"example.com/reporter/internal/filestore"
	"example.com/reporter/internal/report"
)

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Stderr); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("reporter", flag.ContinueOnError)
	fs.SetOutput(stderr)
	dir := fs.String("dir", ".reports", "where reports are stored")
	if err := fs.Parse(args); err != nil {
		return fmt.Errorf("parse flags: %w", err)
	}
	store, err := filestore.Open(*dir)
	if err != nil {
		return err
	}
	svc := report.NewService(store)
	if err := svc.Build("latest", fs.Args()); err != nil {
		return err
	}
	text, err := svc.Show("latest")
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(stdout, text)
	return err
}
GO
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
