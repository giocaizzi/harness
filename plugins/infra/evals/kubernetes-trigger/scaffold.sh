#!/usr/bin/env bash
# A tiny repo with an image build and a namespace manifest.
set -euo pipefail
mkdir -p deploy
cat > Dockerfile <<'DOCKER'
FROM golang:1.23 AS build
WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 go build -o /orders ./cmd/orders
FROM gcr.io/distroless/static:nonroot
COPY --from=build /orders /orders
ENTRYPOINT ["/orders"]
DOCKER
cat > deploy/namespace.yaml <<'YAML'
apiVersion: v1
kind: Namespace
metadata:
  name: orders
YAML
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
