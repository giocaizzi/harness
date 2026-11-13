#!/usr/bin/env bash
# A Helm chart for orders with hard-coded replicas and resources in the deployment template.
set -euo pipefail
mkdir -p charts/orders/templates
cat > charts/orders/Chart.yaml <<'Y'
apiVersion: v2
name: orders
version: 0.1.0
appVersion: "1.4.2"
Y
cat > charts/orders/templates/service.yaml <<'Y'
apiVersion: v1
kind: Service
metadata:
  name: orders
spec:
  selector:
    app: orders
  ports:
    - port: 80
      targetPort: 8000
Y
cat > charts/orders/templates/deployment.yaml <<'Y'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: orders
spec:
  replicas: 3
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
          resources:
            requests:
              cpu: 250m
              memory: 256Mi
            limits:
              memory: 512Mi
Y
cat > charts/orders/values.yaml <<'Y'
image:
  tag: "1.4.2"
Y
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
