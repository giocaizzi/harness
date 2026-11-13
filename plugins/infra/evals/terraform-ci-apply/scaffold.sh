#!/usr/bin/env bash
# A Terraform root with an S3 backend and a CI workflow that only builds the app.
set -euo pipefail
mkdir -p infra .github/workflows
cat > infra/main.tf <<'T'
terraform {
  required_version = ">= 1.9"
  backend "s3" {
    bucket = "acme-tfstate"
    key    = "prod/terraform.tfstate"
    region = "eu-west-1"
  }
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "eu-west-1"
}

resource "aws_s3_bucket" "assets" {
  bucket = "acme-assets"
}
T
cat > infra/.terraform.lock.hcl <<'T'
# This file is maintained automatically by "terraform init".
provider "registry.terraform.io/hashicorp/aws" {
  version     = "5.70.0"
  constraints = "~> 5.0"
}
T
cat > .github/workflows/ci.yml <<'Y'
name: ci
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: make build
Y
cat > Makefile <<'M'
build:
	echo build
M
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
