#!/usr/bin/env bash
# A tiny Terraform root with an orders queue resource already applied.
set -euo pipefail
mkdir -p envs/dev
cat > envs/dev/main.tf <<'TF'
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  backend "s3" {
    bucket = "acme-tfstate"
    key    = "dev/terraform.tfstate"
    region = "eu-west-1"
  }
}

provider "aws" {
  region = "eu-west-1"
}

resource "aws_sqs_queue" "orders" {
  name = "acme-dev-orders"
}
TF
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
