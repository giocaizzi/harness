#!/usr/bin/env bash
# A Terraform repo with dev and prod folders duplicating queue resources.
set -euo pipefail
mkdir -p envs/dev envs/prod
for e in dev prod; do
  cat > envs/$e/variables.tf <<'T'
variable "env" {
  type = string
}
T
  cat > envs/$e/main.tf <<T
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

variable "env_name" {
  default = "$e"
}

locals {
  env = var.env_name
}

resource "aws_sqs_queue" "dlq" {
  name = "orders-\${local.env}-dlq"
}

resource "aws_sqs_queue" "main" {
  name                       = "orders-\${local.env}"
  visibility_timeout_seconds = 60
  message_retention_seconds  = 345600
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = 5
  })
}
T
done
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
