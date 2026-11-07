#!/usr/bin/env bash
# A Go module where orders and billing live in one package.
set -euo pipefail
mkdir -p cmd/shop internal/shop
cat > go.mod <<'MOD'
module acme/shop

go 1.24
MOD
cat > internal/shop/shop.go <<'GO'
package shop

import "database/sql"

type Order struct {
	ID    string
	Total int
	Paid  bool
}

type Invoice struct {
	ID      string
	OrderID string
	Amount  int
}

type Service struct{ db *sql.DB }

func (s *Service) PlaceOrder(o Order) error {
	_, err := s.db.Exec("INSERT INTO orders (id, total) VALUES (?, ?)", o.ID, o.Total)
	return err
}

func (s *Service) Invoice(o Order) (Invoice, error) {
	inv := Invoice{ID: "inv-" + o.ID, OrderID: o.ID, Amount: o.Total}
	_, err := s.db.Exec("INSERT INTO invoices (id, order_id, amount) VALUES (?, ?, ?)", inv.ID, inv.OrderID, inv.Amount)
	return inv, err
}

func (s *Service) MarkPaid(orderID string) error {
	_, err := s.db.Exec("UPDATE orders SET paid = 1 WHERE id = ?", orderID)
	return err
}
GO
cat > cmd/shop/main.go <<'GO'
package main

import "acme/shop/internal/shop"

func main() {
	_ = &shop.Service{}
}
GO
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
