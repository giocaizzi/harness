#!/usr/bin/env bash
# A Terraform root with an S3 backend and no DNS zone yet.
set -euo pipefail
mkdir -p infra
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
cat > infra/README.md <<'M'
The DNS zone for example.com (Route 53 zone id Z0123456789ABC) was created in the console.
M
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
