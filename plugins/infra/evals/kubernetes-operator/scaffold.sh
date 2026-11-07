#!/usr/bin/env bash
# A tiny Go controller that deletes and recreates its ConfigMap on every reconcile.
set -euo pipefail
mkdir -p controllers
cat > go.mod <<'MOD'
module example.com/billing

go 1.23
MOD
cat > controllers/invoice_controller.go <<'GO'
package controllers

import (
	"context"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

type InvoiceReconciler struct{ client.Client }

func (r *InvoiceReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	cm := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Name: req.Name + "-config", Namespace: req.Namespace},
		Data:       map[string]string{"updated": metav1.Now().String()},
	}
	_ = r.Delete(ctx, cm)
	if err := r.Create(ctx, cm); err != nil {
		return ctrl.Result{}, err
	}
	return ctrl.Result{}, nil
}

func (r *InvoiceReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).For(&corev1.ConfigMap{}).Owns(&corev1.ConfigMap{}).Complete(r)
}
GO
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
