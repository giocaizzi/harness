#!/usr/bin/env bash
# A kustomize base with a prod overlay only.
set -euo pipefail
mkdir -p base overlays/prod
cat > base/deployment.yaml <<'Y'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: orders
spec:
  replicas: 2
  selector:
    matchLabels:
      app: orders
  template:
    metadata:
      labels:
        app: orders
    spec:
      containers:
        - name: orders
          image: registry.example.com/acme/orders:latest
          ports:
            - containerPort: 8000
Y
cat > base/kustomization.yaml <<'Y'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - deployment.yaml
Y
cat > overlays/prod/kustomization.yaml <<'Y'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: orders-prod
resources:
  - ../../base
images:
  - name: registry.example.com/acme/orders
    newTag: 1.4.2
replicas:
  - name: orders
    count: 6
Y
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
