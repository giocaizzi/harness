#!/usr/bin/env bash
# A plain Kubernetes deployment for orders with no resource requests or limits.
set -euo pipefail
mkdir -p k8s
cat > k8s/deployment.yaml <<'Y'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: orders
  namespace: acme
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
          image: registry.example.com/acme/orders:1.4.2
          ports:
            - containerPort: 8000
          env:
            - name: LOG_LEVEL
              value: info
Y
cat > k8s/service.yaml <<'Y'
apiVersion: v1
kind: Service
metadata:
  name: orders
  namespace: acme
spec:
  selector:
    app: orders
  ports:
    - port: 80
      targetPort: 8000
Y
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
