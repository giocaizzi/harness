#!/usr/bin/env bash
# A Terraform root with an unpinned AWS provider and no lock file.
set -euo pipefail
mkdir -p infra
cat > infra/main.tf <<'T'
terraform {
  required_version = ">= 1.9"
  required_providers {
    aws = {
      source = "hashicorp/aws"
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
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
