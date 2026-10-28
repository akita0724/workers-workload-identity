terraform {
  required_version = ">= 1.5.0"
  required_providers {
    anthropic = { source = "frank-bee/anthropic", version = "~> 0.7.2" }
  }
}

# Community provider, WIF resources are experimental. ANTHROPIC_OAUTH_TOKEN must have org:admin.
provider "anthropic" {}
variable "issuer_url" { type = string }
variable "audience" { type = string }
variable "subject" {
  type = string
  validation {
    condition     = length(var.subject) > 0 && !strcontains(var.subject, "*")
    error_message = "The subject must be an exact, non-empty value without a wildcard."
  }
}
variable "service_account_id" { type = string }
variable "workspace_id" { type = string }
variable "organization_id" { type = string }

resource "anthropic_federation_issuer" "probe" {
  name       = "workload-probe"
  issuer_url = var.issuer_url
  jwks       = { type = "discovery" }
}

resource "anthropic_federation_rule" "probe" {
  name                   = "workload-probe"
  issuer_id              = anthropic_federation_issuer.probe.id
  match                  = { subject_prefix = var.subject, audience = var.audience }
  target                 = { service_account_id = var.service_account_id }
  workspace_id           = var.workspace_id
  oauth_scope            = "workspace:developer"
  token_lifetime_seconds = 600
}

output "rule_id" { value = anthropic_federation_rule.probe.id }
output "organization_id" { value = var.organization_id }
output "service_account_id" { value = var.service_account_id }
output "workspace_id" { value = var.workspace_id }
