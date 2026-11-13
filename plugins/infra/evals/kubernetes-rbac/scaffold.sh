#!/usr/bin/env bash
# A worker Deployment and ServiceAccount bound to cluster-admin.
set -euo pipefail
mkdir -p k8s
cat > k8s/serviceaccount.yaml <<'Y'
apiVersion: v1
kind: ServiceAccount
metadata:
  name: worker
  namespace: acme
Y
cat > k8s/rbac.yaml <<'Y'
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: worker-admin
subjects:
  - kind: ServiceAccount
    name: worker
    namespace: acme
roleRef:
  kind: ClusterRole
  name: cluster-admin
  apiGroup: rbac.authorization.k8s.io
Y
cat > k8s/deployment.yaml <<'Y'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: worker
  namespace: acme
spec:
  replicas: 1
  selector:
    matchLabels:
      app: worker
  template:
    metadata:
      labels:
        app: worker
    spec:
      serviceAccountName: worker
      containers:
        - name: worker
          image: registry.example.com/acme/worker:2.0.1
Y
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
