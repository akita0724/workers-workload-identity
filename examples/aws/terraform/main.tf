terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "issuer_url" { type = string }
variable "audience" { type = string }
variable "subject" { type = string }
variable "aws_region" { type = string }
variable "name" { type = string }

provider "aws" { region = var.aws_region }

locals { condition_prefix = trimprefix(var.issuer_url, "https://") }

resource "aws_iam_openid_connect_provider" "issuer" {
  url            = var.issuer_url
  client_id_list = [var.audience]
}

data "aws_iam_policy_document" "trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.issuer.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.condition_prefix}:aud"
      values   = [var.audience]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.condition_prefix}:sub"
      values   = [var.subject]
    }
  }
}

resource "aws_iam_role" "probe" {
  name               = var.name
  assume_role_policy = data.aws_iam_policy_document.trust.json
}

output "role_arn" { value = aws_iam_role.probe.arn }
