#!/usr/bin/env bash
# A tiny Terraform repo: one module and a dev root.
set -euo pipefail
mkdir -p modules/queue envs/dev
cat > modules/queue/main.tf <<'TF'
variable "name" {
  type = string
}

resource "aws_sqs_queue" "this" {
  name = var.name
}
TF
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

module "orders_queue" {
  source = "../../modules/queue"
  name   = "acme-dev-orders"
}
TF
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
